import {
  BOOKING_STATUS,
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
  PAYMENT_STATUS,
} from "@/modules/booking/booking.constants.js";
import { createAccessCodeNotificationRepository } from "@/modules/access-codes/access-code.repository.js";
import { reverseMembershipRedemption } from "@/modules/membership/services/membership-entitlement.service.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { emitPaymentRefundedNotificationSafely } from "@/modules/workspace-notifications/workspace-notification.business-events.js";
import {
  publishCustomerBookingLifecycleNotificationSafely,
  publishCustomerRefundNotificationSafely,
} from "@/modules/customer-notifications/index.js";
import { createBookingRepository } from "@/modules/booking/booking.repository.js";
import { createMoneyCreditRepository } from "@/modules/money-credit/money-credit.repository.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import { toObjectId } from "@/shared/helpers/helper.js";
import mongoose from "mongoose";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  fromCurrencyMinorUnits,
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  recordBookingLifecycleEmailInSession,
  dispatchBookingLifecycleEmailSafely,
} from "./booking.customer-notification.service.js";
import type { CommunicationEmailLogDocument } from "@/modules/communication-email-logs/communication-email-log.types.js";

import type { IdLike, TenantId } from "../booking.types.js";
import { calculateWorkshopRefundAmount } from "@/modules/booking/services/booking.pricing.service.js";
import {
  getBookingPaymentRefunds,
  hasVoucherPayment,
  refundBookingOriginalPaymentInSession,
} from "./booking-payment-refund.service.js";

type BookingOrderSnapshot = {
  _id?: IdLike;
  isPaid?: boolean;
  status?: string;
  voucherRedemptions?: unknown[];
  grossAmountMinor?: number;
  paidAmountMinor?: number | null;
  bookingExtension?: {
    bookingId?: IdLike;
    amountMinor?: number;
  } | null;
  currency?: string;
  workshopBookings?: Array<IdLike | { _id?: IdLike }>;
  lineItems?: Array<{
    product?: IdLike | { _id?: IdLike };
    booking?: IdLike | { _id?: IdLike };
    grossAmountMinor?: number;
  }>;
  paymentAllocations?: Array<{
    method?: string;
    amountMinor?: number;
  }>;
  membershipRedemption?: {
    membershipId?: IdLike;
    ledgerEntryId?: IdLike;
    quantity?: number;
  } | null;
  cart?: {
    currency?: string;
    cartItems?: Array<{
      product?: IdLike | { _id?: IdLike };
      totalPrice?: number;
    }>;
  } | null;
};

type CancellableBooking = {
  _id: IdLike;
  createdBy: IdLike;
  status: string;
  paymentStatus?: string;
  start: Date;
  extensionBaseEnd?: Date | null;
  extensionBaseDurationMinutes?: number | null;
  extensionPaymentPendingUntil?: Date | null;
  tag: string;
  location?: IdLike;
  bookingProduct?: {
    _id?: IdLike;
    name?: string | Record<string, string>;
    price?: number;
    currency?: string;
  } | null;
  orders?: BookingOrderSnapshot[];
  numberOfHours?: unknown;
  numberOfGuests?: number;
  financialNumberOfGuests?: number;
  accessCodeCustomerModificationLockedAt?: Date | null;
  accessCodeDelivery?: {
    status?: string;
    leaseExpiresAt?: Date | null;
  };
};

type RefundSnapshot = {
  currency: StudioCommerceCurrency;
  refundAmount: number;
  source:
    | "order_line_snapshot"
    | "order_line_unavailable"
    | "cart_snapshot"
    | "legacy_product_price";
  relatedOrder?: IdLike;
};

export const hasPaidBookingSource = (
  booking: Pick<CancellableBooking, "paymentStatus" | "orders">,
): boolean =>
  String(booking.paymentStatus || "").toUpperCase() ===
    PAYMENT_STATUS.CONFIRMED ||
  Boolean(booking.orders?.some((order) => order?.isPaid === true));

const orderContainsBooking = (
  order: BookingOrderSnapshot,
  bookingId: IdLike,
): boolean =>
  Boolean(
    order.workshopBookings?.some(
      (candidate) => getId(candidate) === getId(bookingId),
    ),
  );

const membershipCreditOrderForBooking = (
  booking: CancellableBooking,
): BookingOrderSnapshot | null =>
  booking.orders?.find(
    (order) =>
      order.isPaid === true &&
      orderContainsBooking(order, booking._id) &&
      order.paymentAllocations?.some(
        (allocation) => allocation?.method === "membership_credit",
      ),
  ) ?? null;

const getId = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id?: unknown })._id ?? "");
  }

  return String(value ?? "");
};

const getProductName = (value: unknown): string => {
  if (value && typeof value === "object") {
    const localized = value as Record<string, unknown>;
    return String(localized.CZ ?? localized.EN ?? "Unknown service");
  }

  return String(value || "Unknown service");
};

const normalizeRefundCurrency = (value: unknown): StudioCommerceCurrency => {
  try {
    return normalizeStudioCommerceCurrency(value);
  } catch {
    badRequest({
      message: "Booking refund has an unsupported currency snapshot.",
      code: "REFUND_CURRENCY_UNSUPPORTED",
      details: { currency: value },
    });
  }
};

const extensionOrdersForBooking = (booking: CancellableBooking) => {
  const seen = new Set<string>();
  return (booking.orders ?? []).filter((order) => {
    if (order.isPaid !== true || !order.bookingExtension) return false;
    const key = getId(order._id);
    if (!key)
      conflict({
        code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        message: "The paid extension has no identifiable order.",
      });
    if (seen.has(key)) return false;
    seen.add(key);
    if (
      getId(order.bookingExtension.bookingId) !== getId(booking._id) ||
      !orderContainsBooking(order, booking._id)
    ) {
      conflict({
        code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        message: "The extension payment is not associated with this booking.",
      });
    }
    return true;
  });
};

/** Only the explicit, immutable extension payment is refundable as added time. */
export const resolveBookingExtensionRefund = (
  booking: CancellableBooking,
  currency: StudioCommerceCurrency,
): number => {
  let total = 0;
  for (const order of extensionOrdersForBooking(booking)) {
    if (
      normalizeRefundCurrency(order.currency) !== currency ||
      (order.cart?.currency &&
        normalizeRefundCurrency(order.cart.currency) !== currency)
    ) {
      badRequest({
        code: "REFUND_CURRENCY_SNAPSHOT_MISMATCH",
        message:
          "The extension and original booking have different currency snapshots.",
      });
    }
    const lines = (order.lineItems ?? []).filter(
      (line) => getId(line.booking) === getId(booking._id),
    );
    const amount = Number(order.bookingExtension?.amountMinor);
    const allocations = order.paymentAllocations ?? [];
    const cardPaidMinor = allocations
      .filter((allocation) => allocation.method === "stripe")
      .reduce((sum, allocation) => sum + Number(allocation.amountMinor), 0);
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      lines.length !== 1 ||
      Number(lines[0].grossAmountMinor) !== amount ||
      order.grossAmountMinor !== amount ||
      order.paidAmountMinor !== cardPaidMinor ||
      allocations.some(
        (allocation) =>
          !Number.isSafeInteger(allocation.amountMinor) ||
          Number(allocation.amountMinor) < 0,
      ) ||
      allocations.some(
        (allocation) =>
          !["stripe", "credits", "free"].includes(String(allocation.method)),
      ) ||
      allocations.reduce(
        (sum, allocation) => sum + Number(allocation.amountMinor),
        0,
      ) !== amount
    ) {
      conflict({
        code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        message:
          "The paid extension snapshot cannot be refunded automatically.",
      });
    }
    total += amount;
    if (!Number.isSafeInteger(total)) {
      conflict({
        code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        message: "The total extension refund is invalid.",
      });
    }
  }
  return total;
};

export const resolveBookingRefundSnapshot = (
  booking: CancellableBooking,
  tenantCurrency: StudioCommerceCurrency,
): RefundSnapshot => {
  const extensions = extensionOrdersForBooking(booking);
  if (extensions.length) {
    const original = resolveBookingRefundSnapshot(
      {
        _id: booking._id,
        createdBy: booking.createdBy,
        status: booking.status,
        start: booking.start,
        tag: booking.tag,
        bookingProduct: booking.bookingProduct,
        numberOfGuests: booking.numberOfGuests,
        financialNumberOfGuests: booking.financialNumberOfGuests,
        orders: (booking.orders ?? []).filter(
          (order) => !order.bookingExtension,
        ),
        // Legacy pricing must never use the enlarged duration and then add the
        // extension payment a second time.
        numberOfHours: booking.extensionBaseDurationMinutes
          ? booking.extensionBaseDurationMinutes / 60
          : booking.numberOfHours,
      },
      tenantCurrency,
    );
    if (original.source === "order_line_unavailable") return original;
    const amountMinor =
      toCurrencyMinorUnits(original.refundAmount, original.currency) +
      resolveBookingExtensionRefund(booking, original.currency);
    if (!Number.isSafeInteger(amountMinor)) {
      conflict({
        code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        message: "The total booking refund is invalid.",
      });
    }
    return {
      ...original,
      refundAmount: fromCurrencyMinorUnits(amountMinor, original.currency),
    };
  }
  const productId = getId(booking.bookingProduct?._id);
  const orders = [...(booking.orders || [])].sort(
    (left, right) =>
      Number(right.isPaid === true) - Number(left.isPaid === true),
  );

  let matchedOrder: BookingOrderSnapshot | undefined;
  let modernRelevantOrder: BookingOrderSnapshot | undefined;
  let matchedAmountMinor: number | undefined;
  let matchedTotal: number | undefined;

  for (const order of orders) {
    if (order.isPaid !== true) continue;
    if (
      order.workshopBookings?.length &&
      !orderContainsBooking(order, booking._id)
    ) {
      continue;
    }

    const bookingMatchedLines = (order.lineItems || []).filter(
      (line) => getId(line.booking) === getId(booking._id),
    );
    const matchingLines = bookingMatchedLines.length
      ? bookingMatchedLines
      : (order.lineItems || []).filter(
          (line) => getId(line.product) === productId,
        );

    if (order.lineItems?.length) {
      modernRelevantOrder ??= order;
    }

    if (matchingLines.length > 0) {
      const matchingAmounts = [
        ...new Set(
          matchingLines
            .map((line) => Number(line.grossAmountMinor))
            .filter(
              (amountMinor) =>
                Number.isSafeInteger(amountMinor) && amountMinor >= 0,
            ),
        ),
      ];
      const amountMinor =
        matchingAmounts.length === 1 ? matchingAmounts[0] : Number.NaN;

      if (Number.isSafeInteger(amountMinor) && amountMinor >= 0) {
        matchedOrder = order;
        matchedAmountMinor = amountMinor;
        break;
      }
    }

    // Modern orders must use their immutable, discounted invoice lines.
    // Falling back to catalog cart totals could over-credit a discounted sale.
    if (order.lineItems?.length) continue;

    const matchingItems = (order.cart?.cartItems || []).filter(
      (item) => getId(item.product) === productId,
    );

    if (matchingItems.length !== 1) {
      continue;
    }

    const total = Number(matchingItems[0].totalPrice);

    if (Number.isFinite(total) && total > 0) {
      matchedOrder = order;
      matchedTotal = total;
      break;
    }
  }

  const fallbackOrder =
    orders.find((order) => order.isPaid === true) ?? orders[0];
  const currencyOrder = matchedOrder ?? fallbackOrder;
  const orderCurrency = currencyOrder?.currency;
  const cartCurrency = currencyOrder?.cart?.currency;

  if (
    orderCurrency &&
    cartCurrency &&
    normalizeRefundCurrency(orderCurrency) !==
      normalizeRefundCurrency(cartCurrency)
  ) {
    badRequest({
      message: "Booking payment contains conflicting currency snapshots.",
      code: "REFUND_CURRENCY_SNAPSHOT_MISMATCH",
      details: { orderCurrency, cartCurrency },
    });
  }

  const currency = normalizeRefundCurrency(
    orderCurrency ??
      cartCurrency ??
      booking.bookingProduct?.currency ??
      tenantCurrency,
  );

  if (matchedAmountMinor !== undefined) {
    return {
      currency,
      refundAmount: fromCurrencyMinorUnits(matchedAmountMinor, currency),
      source: "order_line_snapshot",
      relatedOrder: matchedOrder?._id,
    };
  }

  if (modernRelevantOrder) {
    return {
      currency,
      refundAmount: 0,
      source: "order_line_unavailable",
      relatedOrder: modernRelevantOrder._id,
    };
  }

  if (matchedTotal !== undefined) {
    let normalizedAmount: number;

    try {
      const amountMinor = toCurrencyMinorUnits(matchedTotal, currency);
      normalizedAmount = fromCurrencyMinorUnits(amountMinor, currency);
    } catch {
      badRequest({
        message: `Booking refund amount has invalid precision for ${currency}.`,
        code: "INVALID_CURRENCY_PRECISION",
        details: { amount: matchedTotal, currency },
      });
    }

    if (Math.abs(normalizedAmount - matchedTotal) > 1e-9) {
      badRequest({
        message: `Booking refund amount has invalid precision for ${currency}.`,
        code: "INVALID_CURRENCY_PRECISION",
        details: { amount: matchedTotal, currency },
      });
    }

    return {
      currency,
      refundAmount: normalizedAmount,
      source: "cart_snapshot",
      relatedOrder: matchedOrder?._id,
    };
  }

  let pricing: ReturnType<typeof calculateWorkshopRefundAmount>;

  try {
    pricing = calculateWorkshopRefundAmount({
      bookingProduct: {
        price: booking.bookingProduct?.price,
      },
      numberOfHours: booking.numberOfHours as
        number | { toString: () => string } | null | undefined,
      numberOfGuests: booking.financialNumberOfGuests ?? booking.numberOfGuests,
      currency,
    });
  } catch {
    badRequest({
      message: `Booking refund amount has invalid precision for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: { currency },
    });
  }

  return {
    currency,
    refundAmount: pricing.refundAmount,
    source: "legacy_product_price",
    relatedOrder: fallbackOrder?._id,
  };
};

const validateCancellableBooking = (
  booking: CancellableBooking | null | undefined,
  userId: IdLike,
): CancellableBooking => {
  if (!booking) notFound("Booking not found");
  if (String(booking.createdBy) !== String(userId)) {
    forbidden("You can only cancel your own bookings");
  }
  if (booking.status === BOOKING_STATUS.CANCELLED) {
    badRequest("Booking is already cancelled");
  }
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    badRequest("Completed bookings cannot be cancelled");
  }
  if (new Date() >= booking.start) {
    badRequest("Ongoing or past bookings cannot be cancelled");
  }
  if ((CLASS_BOOKING_TAGS as readonly string[]).includes(booking.tag)) {
    badRequest(
      "Class bookings cannot be cancelled or refunded. Only Open Studio bookings are eligible for refunds.",
    );
  }
  if (!(OPEN_STUDIO_BOOKING_TAGS as readonly string[]).includes(booking.tag)) {
    badRequest("Only Open Studio bookings can be cancelled and refunded.");
  }

  return booking;
};

export const cancelBookingWithRefund = async ({
  tenantId,
  bookingId,
  userId,
  actorUserId = String(userId),
}: {
  tenantId: TenantId;
  bookingId: IdLike;
  userId: IdLike;
  actorUserId?: string;
}) => {
  const session = await mongoose.startSession();

  try {
    let result: unknown;
    let customerRefundKey = "";
    let lifecycleEmail: CommunicationEmailLogDocument | null = null;

    const cancelInSession = async () => {
      const bookingRepository = createBookingRepository({
        tenantId,
        session,
      });

      const moneyCreditRepository = createMoneyCreditRepository({
        tenantId,
        session,
      });

      const booking = (await bookingRepository.findDocumentById(bookingId, {
        populate: [
          {
            path: "bookingProduct",
            select: "name price currency",
          },
          {
            path: "orders",
            select:
              "currency isPaid status grossAmountMinor paidAmountMinor lineItems paymentAllocations voucherRedemptions membershipRedemption workshopBookings cart bookingExtension",
            populate: {
              path: "cart",
              select: "currency cartItems totalPrice",
            },
          },
        ],
      })) as CancellableBooking | null;

      if (
        booking &&
        String(booking.createdBy) === String(userId) &&
        booking.status === BOOKING_STATUS.CANCELLED &&
        booking.orders?.some(hasVoucherPayment)
      ) {
        const refunds = await getBookingPaymentRefunds({
          tenantId: String(tenantId),
          bookingId: String(booking._id),
          session,
        });
        if (refunds.length === 1) {
          result = {
            booking,
            refundType: "original_payment",
            refundAmount: fromCurrencyMinorUnits(
              refunds[0].amountMinor,
              refunds[0].currency,
            ),
            currency: refunds[0].currency,
            refund: refunds[0],
            idempotent: true,
            message:
              "Booking was already cancelled. The original payment refund has been recorded.",
          };
          return;
        }
      }
      const cancellableBooking = validateCancellableBooking(booking, userId);
      if (!hasPaidBookingSource(cancellableBooking)) {
        conflict({
          message:
            "An unpaid checkout hold cannot be cancelled as a booking. It will expire automatically.",
          code: "UNPAID_BOOKING_CANCELLATION_NOT_ALLOWED",
        });
      }
      if (
        new Date(
          cancellableBooking.extensionPaymentPendingUntil || 0,
        ).getTime() > Date.now()
      ) {
        conflict({
          code: "CUSTOMER_BOOKING_EXTENSION_PENDING",
          message:
            "Complete or cancel the pending extension payment before cancelling this booking.",
        });
      }
      const accessCodeNotifications = createAccessCodeNotificationRepository({
        tenantId,
        session,
      });
      const bookingDeliveryStatus = String(
        cancellableBooking.accessCodeDelivery?.status || "idle",
      );
      const bookingDeliveryLease = new Date(
        cancellableBooking.accessCodeDelivery?.leaseExpiresAt || 0,
      ).getTime();
      if (
        cancellableBooking.accessCodeCustomerModificationLockedAt ||
        bookingDeliveryStatus === "sent" ||
        bookingDeliveryStatus === "delivery_unknown" ||
        (bookingDeliveryStatus === "processing" &&
          bookingDeliveryLease > Date.now()) ||
        (await accessCodeNotifications.hasModificationLockForBooking(
          cancellableBooking._id,
        ))
      ) {
        conflict({
          message:
            "This booking can no longer be cancelled because its access code has already been issued or is being delivered.",
          code: "BOOKING_ACCESS_ALREADY_ISSUED",
        });
      }

      cancellableBooking.status = BOOKING_STATUS.CANCELLED;
      cancellableBooking.accessCodeDelivery = {
        status: "cancelled",
        leaseExpiresAt: null,
      };

      await bookingRepository.save(cancellableBooking as never);
      await accessCodeNotifications.markCancelled(cancellableBooking._id);

      // The original payment can be a membership allowance or voucher, while
      // added time is a separate card/credit payment. Restore each source once
      // in this same cancellation transaction.
      const refundAddedTime = async (currency: StudioCommerceCurrency) => {
        const amountMinor = resolveBookingExtensionRefund(
          cancellableBooking,
          currency,
        );
        if (!amountMinor) return 0;
        const record = await moneyCreditRepository.findByUser(userId);
        const previous = record?.transactions?.find(
          (transaction) =>
            transaction?.type === MONEY_CREDIT_TRANSACTION_TYPE.REFUND &&
            String(transaction.relatedBooking) ===
              String(cancellableBooking._id),
        );
        if (previous) {
          conflict({
            code: "BOOKING_REFUND_REVIEW_REQUIRED",
            message:
              "A refund already exists for this booking. Please contact the studio.",
          });
        }
        const amount = fromCurrencyMinorUnits(amountMinor, currency);
        const credited = await moneyCreditService.incrementMoneyCredits({
          tenantId,
          userId,
          amount,
          currency,
          session,
          transaction: {
            type: MONEY_CREDIT_TRANSACTION_TYPE.REFUND,
            description: `Refund for added booking time - ${getProductName(cancellableBooking.bookingProduct?.name)}`,
            relatedBooking: toObjectId(String(cancellableBooking._id)),
            relatedOrder: toObjectId(
              getId(extensionOrdersForBooking(cancellableBooking)[0]._id),
            ),
          },
        });
        customerRefundKey =
          credited.transactionId ??
          `booking:${String(cancellableBooking._id)}:extension-refund`;
        return amount;
      };

      const membershipCreditOrder =
        membershipCreditOrderForBooking(cancellableBooking);

      if (membershipCreditOrder) {
        if (cancellableBooking.orders?.some(hasVoucherPayment)) {
          conflict({
            code: "BOOKING_PAYMENT_REFUND_REVIEW_REQUIRED",
            message:
              "A combined membership and voucher payment requires source review.",
          });
        }
        const membershipId = getId(
          membershipCreditOrder.membershipRedemption?.membershipId,
        );
        const redemptionEntryId = getId(
          membershipCreditOrder.membershipRedemption?.ledgerEntryId,
        );

        if (!membershipId || !redemptionEntryId) {
          conflict({
            message:
              "The membership credit could not be restored automatically. Please contact the studio.",
            code: "MEMBERSHIP_REFUND_SNAPSHOT_MISSING",
          });
        }

        await reverseMembershipRedemption({
          tenantId: String(tenantId),
          membershipId,
          redemptionEntryId,
          reason: "booking_cancelled",
          actorId: String(userId),
          idempotencyKey: `booking:${String(cancellableBooking._id)}:membership-credit:refund`,
          session,
        });

        const currency = normalizeRefundCurrency(
          membershipCreditOrder.currency ||
            membershipCreditOrder.cart?.currency ||
            cancellableBooking.bookingProduct?.currency,
        );
        const extensionRefundAmount = await refundAddedTime(currency);

        result = {
          booking: cancellableBooking,
          refundAmount: extensionRefundAmount,
          extensionRefundAmount,
          currency,
          refundType: "membership_credit",
          membershipQuantity:
            membershipCreditOrder.membershipRedemption?.quantity ?? 0,
          message:
            "Booking cancelled successfully. The membership credit was restored.",
        };
        customerRefundKey = `booking:${String(cancellableBooking._id)}:membership-credit:refund`;

        return;
      }

      const relatedPaidOrders = (cancellableBooking.orders ?? []).filter(
        (order) =>
          order.isPaid === true &&
          !order.bookingExtension &&
          orderContainsBooking(order, cancellableBooking._id),
      );
      const voucherOrders = (cancellableBooking.orders ?? []).filter(
        (order) => order.isPaid === true && hasVoucherPayment(order),
      );
      if (voucherOrders.length) {
        // Supplemental guest payments can have a separate funding source. Do
        // not infer how to allocate an incomplete historical payment history.
        if (
          relatedPaidOrders.length !== 1 ||
          voucherOrders.length !== 1 ||
          !orderContainsBooking(voucherOrders[0], cancellableBooking._id)
        ) {
          conflict({
            code: "BOOKING_PAYMENT_REFUND_REVIEW_REQUIRED",
            message:
              "This booking has multiple paid orders and requires payment-source review before cancellation.",
          });
        }
        const refund = await refundBookingOriginalPaymentInSession({
          tenantId: String(tenantId),
          orderId: getId(voucherOrders[0]._id),
          bookingId: String(cancellableBooking._id),
          actorId: actorUserId,
          reason: "booking_cancelled",
          session,
        });
        if (!refund)
          conflict({
            code: "BOOKING_PAYMENT_REFUND_REVIEW_REQUIRED",
            message: "The voucher payment snapshot is unavailable.",
          });
        const extensionRefundAmount = await refundAddedTime(
          normalizeRefundCurrency(refund.currency),
        );
        result = {
          booking: cancellableBooking,
          refundType: "original_payment",
          refund,
          extensionRefundAmount,
          refundAmount:
            extensionRefundAmount +
            fromCurrencyMinorUnits(refund.amountMinor, refund.currency),
          currency: refund.currency,
          message: [
            "Booking cancelled.",
            refund.voucherAmountMinor > 0
              ? "Voucher value was restored with its original expiry."
              : "",
            refund.cardAmountMinor > 0
              ? "The card refund has been queued."
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
        return;
      }

      const tenant = await TenantModel.findById(toObjectId(String(tenantId)))
        .select("settings.currency")
        .session(session)
        .lean()
        .exec();

      if (!tenant) {
        notFound("Tenant not found.");
      }

      const tenantCurrency = normalizeRefundCurrency(tenant.settings?.currency);
      const refundSnapshot = resolveBookingRefundSnapshot(
        cancellableBooking,
        tenantCurrency,
      );

      if (refundSnapshot.source === "order_line_unavailable") {
        conflict({
          message:
            "This booking contains an ambiguous paid line and cannot be refunded automatically. Please contact the studio.",
          code: "BOOKING_REFUND_LINE_AMBIGUOUS",
        });
      }

      if (refundSnapshot.refundAmount <= 0) {
        result = {
          booking: cancellableBooking,
          refundAmount: 0,
          currency: refundSnapshot.currency,
          message:
            "Booking was cancelled, but no refund amount could be calculated.",
        };

        return;
      }

      const creditRecord = await moneyCreditRepository.findByUser(userId);

      const alreadyRefunded =
        creditRecord?.transactions?.some(
          (transaction) =>
            transaction?.type === MONEY_CREDIT_TRANSACTION_TYPE.REFUND &&
            String(transaction?.relatedBooking) ===
              String(cancellableBooking._id),
        ) || false;

      if (alreadyRefunded) {
        result = {
          booking: cancellableBooking,
          refundAmount: 0,
          currency: refundSnapshot.currency,
          message:
            "Booking cancelled successfully. Refund was already issued previously.",
        };

        return;
      }

      const creditResult = await moneyCreditService.incrementMoneyCredits({
        tenantId,
        userId,
        amount: refundSnapshot.refundAmount,
        currency: refundSnapshot.currency,
        transaction: {
          type: MONEY_CREDIT_TRANSACTION_TYPE.REFUND,
          description: `Refund for cancelled booking - ${getProductName(
            cancellableBooking.bookingProduct?.name,
          )}`,
          relatedBooking: toObjectId(String(cancellableBooking._id)),
          relatedOrder: refundSnapshot.relatedOrder
            ? toObjectId(String(refundSnapshot.relatedOrder))
            : null,
        },
        session,
      });

      result = {
        booking: cancellableBooking,
        refundAmount: refundSnapshot.refundAmount,
        currency: refundSnapshot.currency,
        newCreditBalance: creditResult.newBalance,
        pricing: {
          source: refundSnapshot.source,
          refundAmount: refundSnapshot.refundAmount,
          currency: refundSnapshot.currency,
        },
        message: `Booking cancelled successfully! ${refundSnapshot.refundAmount} ${refundSnapshot.currency} has been added to your credits.`,
      };
      customerRefundKey =
        creditResult.transactionId ??
        `booking:${String(cancellableBooking._id)}:credit-refund`;
    };
    await session.withTransaction(async () => {
      lifecycleEmail = null;
      await cancelInSession();
      const snapshot = result as {
        idempotent?: boolean;
        refundAmount?: number;
        currency?: string;
        refundType?: string;
        extensionRefundAmount?: number;
        refund?: { cardAmountMinor?: number; voucherAmountMinor?: number };
      };
      if (!snapshot.idempotent) {
        lifecycleEmail = await recordBookingLifecycleEmailInSession(
          {
            tenantId: String(tenantId),
            userId: String(userId),
            bookingId: String(bookingId),
            event: "cancelled",
            refundAmount: snapshot.refundAmount,
            refundCurrency: snapshot.currency,
            refundType: snapshot.refundType,
            refundCardAmountMinor: snapshot.refund?.cardAmountMinor,
            refundVoucherAmountMinor: snapshot.refund?.voucherAmountMinor,
            refundExtraCreditAmount: snapshot.extensionRefundAmount,
          },
          session,
        );
      }
    });
    await dispatchBookingLifecycleEmailSafely(lifecycleEmail);

    const completedResult = result as
      | {
          booking?: CancellableBooking;
          refundAmount?: number;
          refundType?: string;
          currency?: string;
          extensionRefundAmount?: number;
        }
      | undefined;
    const completedBooking = completedResult?.booking;
    const refundedAmount = Number(
      completedResult?.refundType === "original_payment"
        ? (completedResult.extensionRefundAmount ?? 0)
        : (completedResult?.refundAmount ?? 0),
    );
    const membershipCreditRestored =
      completedResult?.refundType === "membership_credit";
    const completedBookingId = getId(completedBooking?._id);
    const completedLocationId = getId(completedBooking?.location);
    const completedRecipientUserId =
      getId(completedBooking?.createdBy) || String(userId);

    if (completedBookingId && completedRecipientUserId) {
      await publishCustomerBookingLifecycleNotificationSafely({
        tenantId: String(tenantId),
        recipientUserId: completedRecipientUserId,
        bookingId: completedBookingId,
        ...(completedLocationId ? { locationId: completedLocationId } : {}),
        event: "cancelled",
      });
    }

    if (
      completedBookingId &&
      completedLocationId &&
      (completedResult?.refundType !== "original_payment" ||
        refundedAmount > 0) &&
      (refundedAmount > 0 || membershipCreditRestored)
    ) {
      emitPaymentRefundedNotificationSafely({
        tenantId: String(tenantId),
        bookingId: completedBookingId,
        actorUserId: String(userId),
        locationId: completedLocationId,
        refundAmount: refundedAmount,
        ...(completedResult?.currency
          ? { currency: completedResult.currency }
          : {}),
        membershipCreditRestored,
      });
      await publishCustomerRefundNotificationSafely({
        tenantId: String(tenantId),
        recipientUserId: String(userId),
        bookingId: completedBookingId,
        locationId: completedLocationId,
        refundAmount: refundedAmount,
        ...(completedResult?.currency
          ? { currency: completedResult.currency }
          : {}),
        membershipCreditRestored,
        refundKey:
          customerRefundKey || `booking:${completedBookingId}:customer-refund`,
      });
    }

    return result;
  } finally {
    await session.endSession();
  }
};
