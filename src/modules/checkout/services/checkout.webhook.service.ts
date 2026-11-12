import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

import Booking from "@/modules/booking/booking.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import {
  toObjectId,
  withTenantId,
  WebhookOrder,
  WebhookTenantContext,
  StripeSessionLike,
} from "@/shared/middleware/webhook.js";
import { buildGuestIncreaseCapacityHoldRequirement } from "../checkout.guest-capacity-hold.js";
import { reconcileWaitlistAfterDirectCourseBooking } from "@/modules/waitlist/waitlist.service.js";

export { processWorkshopBookingsAfterPayment } from "./checkout.workshop-fulfillment.service.js";

export const processGuestIncreaseBookingsAfterPayment = async (
  order: WebhookOrder,
  {
    tenantId,
    session = null,
  }: WebhookTenantContext & { session?: mongoose.ClientSession | null },
) => {
  if (!order?._id) return false;

  const raw = Array.isArray(order.guestIncreaseBookings)
    ? order.guestIncreaseBookings
    : [];

  if (!raw.length) return true;

  const orderId = toObjectId(order._id);

  const ops = raw
    .map((item) => {
      const bookingId = item?.bookingId || item?.booking;
      const addGuests = Math.floor(Number(item?.addGuests));

      if (!mongoose.Types.ObjectId.isValid(String(bookingId))) return null;
      if (!Number.isFinite(addGuests) || addGuests <= 0) return null;

      return {
        bookingId: toObjectId(String(bookingId)),
        addGuests,
        capacityReserved: item?.capacityReserved === true,
      };
    })
    .filter(
      (
        item,
      ): item is {
        bookingId: mongoose.Types.ObjectId;
        addGuests: number;
        capacityReserved: boolean;
      } => Boolean(item),
    );

  if (!ops.length) return true;

  const byId = new Map<
    string,
    { addGuests: number; capacityReserved: boolean }
  >();

  for (const op of ops) {
    const key = String(op.bookingId);
    const current = byId.get(key);
    byId.set(key, {
      addGuests: (current?.addGuests || 0) + op.addGuests,
      capacityReserved:
        current?.capacityReserved === true || op.capacityReserved === true,
    });
  }

  for (const [id, operation] of byId.entries()) {
    const { addGuests, capacityReserved } = operation;
    const now = new Date();
    const result = await Booking.updateOne(
      withTenantId(tenantId, {
        _id: toObjectId(id),
        tag: { $in: ["open-studio", "workshop"] },
        orders: { $ne: orderId },
        ...buildGuestIncreaseCapacityHoldRequirement({
          orderId,
          addGuests,
          capacityReserved,
          now,
        }),
      }),
      [
        {
          $set: {
            numberOfGuests: {
              $add: [{ $ifNull: ["$numberOfGuests", 0] }, addGuests],
            },
            financialNumberOfGuests: {
              $cond: [
                "$attendanceManaged",
                {
                  $add: [
                    {
                      $max: [
                        1,
                        {
                          $ifNull: [
                            "$financialNumberOfGuests",
                            "$numberOfGuests",
                          ],
                        },
                      ],
                    },
                    addGuests,
                  ],
                },
                "$financialNumberOfGuests",
              ],
            },
            participants: {
              $cond: [
                "$attendanceManaged",
                {
                  $concatArrays: [
                    { $ifNull: ["$participants", []] },
                    Array.from({ length: addGuests }, () => ({
                      participantId: randomUUID(),
                      firstname: "Unnamed participant",
                      lastname: "",
                      unnamed: true,
                      source: "paid",
                      attendanceStatus: "active",
                      order: orderId,
                    })),
                  ],
                },
                { $ifNull: ["$participants", []] },
              ],
            },
            orders: { $setUnion: [{ $ifNull: ["$orders", []] }, [orderId]] },
            capacityReservations: {
              $filter: {
                input: { $ifNull: ["$capacityReservations", []] },
                as: "hold",
                cond: { $ne: ["$$hold.order", orderId] },
              },
            },
          },
        },
      ],
      { session, updatePipeline: true },
    ).exec();

    if (result.modifiedCount === 1) continue;

    const alreadyFulfilled = await Booking.exists(
      withTenantId(tenantId, {
        _id: toObjectId(id),
        tag: { $in: ["open-studio", "workshop"] },
        orders: orderId,
      }),
    )
      .session(session)
      .exec();

    if (!alreadyFulfilled) {
      throw new Error(
        `Guest capacity reservation for order ${String(orderId)} could not be consumed.`,
      );
    }
  }

  return true;
};

const buildCourseParticipants = (
  quantity: number,
  customer: WebhookOrder["customer"],
  orderObjId: mongoose.Types.ObjectId,
  customerId?: unknown,
) => {
  const q = Math.max(1, Number(quantity) || 1);
  const firstname = customer?.firstname || "Unknown";
  const lastname = customer?.lastname || "Unknown";
  const customId = customer?.customId;
  const memberNumber = customer?.memberNumber;

  const participants = [
    {
      customer: customerId ? toObjectId(String(customerId)) : undefined,
      firstname,
      lastname,
      customId,
      memberNumber,
      order: orderObjId,
      participantId: randomUUID(),
      source: "paid",
      attendanceStatus: "active",
      unnamed: false,
    },
  ];

  for (let index = 1; index < q; index += 1) {
    participants.push({
      customer: undefined,
      firstname: `${firstname}_GUEST_${index}`,
      lastname: `${lastname}_GUEST_${index}`,
      customId,
      memberNumber,
      order: orderObjId,
      participantId: randomUUID(),
      source: "paid",
      attendanceStatus: "active",
      unnamed: true,
    });
  }

  return { participants, guestsToAdd: q };
};

export const processCourseBookingsAfterPayment = async (
  order: WebhookOrder,
  {
    tenantId,
    session = null,
  }: WebhookTenantContext & { session?: mongoose.ClientSession | null },
) => {
  if (!order?._id) return false;

  const orderId = toObjectId(order._id);
  const courseSlots = Array.isArray(order.courseBookings)
    ? order.courseBookings
    : [];

  if (!courseSlots.length) return true;

  const bookingBySlot = new Map<
    string,
    { quantity: number; capacityReserved: boolean }
  >();

  for (const slot of courseSlots) {
    if (
      !slot?.bookingId ||
      !mongoose.Types.ObjectId.isValid(String(slot.bookingId))
    ) {
      continue;
    }

    const key = String(slot.bookingId);
    const quantity = Math.max(1, Number(slot.quantity) || 1);

    const current = bookingBySlot.get(key);
    bookingBySlot.set(key, {
      quantity: (current?.quantity || 0) + quantity,
      capacityReserved:
        current?.capacityReserved === true || slot.capacityReserved === true,
    });
  }

  for (const [slotId, booking] of bookingBySlot.entries()) {
    const { quantity, capacityReserved } = booking;
    const { participants, guestsToAdd } = buildCourseParticipants(
      quantity,
      order.customer,
      orderId,
      order.createdBy,
    );

    const result = await Booking.updateOne(
      withTenantId(tenantId, {
        _id: toObjectId(slotId),
        tag: { $in: ["class", "course"] },
        "participants.order": { $ne: orderId },
        ...(capacityReserved
          ? {
              capacityReservations: {
                $elemMatch: {
                  order: orderId,
                  quantity,
                },
              },
            }
          : {}),
      }),
      {
        $push: { participants: { $each: participants } },
        $inc: { numberOfGuests: guestsToAdd },
        $addToSet: { orders: orderId },
        $pull: { capacityReservations: { order: orderId } },
      },
      { session },
    ).exec();

    if (result.modifiedCount !== 1) {
      const alreadyFulfilled = await Booking.exists(
        withTenantId(tenantId, {
          _id: toObjectId(slotId),
          tag: { $in: ["class", "course"] },
          "participants.order": orderId,
        }),
      )
        .session(session)
        .exec();

      if (!alreadyFulfilled) {
        throw new Error(
          `Class capacity reservation for order ${String(orderId)} could not be consumed.`,
        );
      }
    }

    if (!(order as any).guestCourseCheckout)
      await reconcileWaitlistAfterDirectCourseBooking({
        tenantId,
        sessionId: slotId,
        orderId: String(orderId),
        customerId: order.createdBy ? String(order.createdBy) : undefined,
        email: order.customer?.email,
        mongoSession: session,
      });
  }

  return true;
};

export const processPromoCodesAfterPayment = async (
  order: WebhookOrder,
  { tenantId }: WebhookTenantContext,
) => {
  if (!order?._id) return { ok: true, redeemed: 0, skipped: 0 };

  const now = new Date();
  const orderId = toObjectId(order._id);
  const applied = Array.isArray(order.appliedCoupons)
    ? order.appliedCoupons
    : [];

  if (!applied.length) return { ok: true, redeemed: 0, skipped: 0 };

  let redeemed = 0;
  let skipped = 0;

  for (const item of applied) {
    const promoCode = String(item?.promoCode || "")
      .trim()
      .toUpperCase();

    if (!promoCode) {
      skipped += 1;
      continue;
    }

    const filter = withTenantId(tenantId, {
      promoCode,
      reservedOrder: orderId,
      $or: [{ redeemedAt: { $exists: false } }, { redeemedAt: null }],
    });

    if (
      item?.couponId &&
      mongoose.Types.ObjectId.isValid(String(item.couponId))
    ) {
      filter._id = toObjectId(String(item.couponId));
    }

    const updated = await Coupon.findOneAndUpdate(
      filter,
      {
        $set: {
          redeemedAt: now,
          redeemedBy: order.createdBy,
          order: orderId,
          isActive: false,
        },
        $unset: {
          reservedAt: 1,
          reservedBy: 1,
          reservedOrder: 1,
          reservedUntil: 1,
        },
      },
      { returnDocument: "after" },
    ).lean();

    if (updated) redeemed += 1;
    else skipped += 1;
  }

  return { ok: true, redeemed, skipped };
};

export const processCreditsDiscountAfterPayment = async ({
  tenantId,
  order,
  session,
}: {
  tenantId: string;
  order: WebhookOrder;
  session?: StripeSessionLike;
}) => {
  if (!order?._id) {
    throw new Error("Missing order in credits-discount processor");
  }

  if (!order.createdBy) {
    throw new Error("Missing user on order for credits discount");
  }

  const orderId = order._id;
  const metaApplied = Number(session?.metadata?.creditsAppliedMajor || 0);
  const orderApplied = Number(order.credits?.appliedMajor || 0);
  const amount =
    Number.isFinite(orderApplied) && orderApplied > 0 ? orderApplied : 0;

  if (
    Number.isFinite(metaApplied) &&
    metaApplied > 0 &&
    Math.abs(metaApplied - amount) > 1e-9
  ) {
    throw new Error(
      "Stripe credits metadata does not match the order snapshot",
    );
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: true, skipped: true, reason: "no_credits_applied" };
  }

  const userId = order.createdBy;
  const currency = normalizeStudioCommerceCurrency(
    order.credits?.currency ?? order.currency,
  );
  const sessionCurrency = session?.currency
    ? normalizeStudioCommerceCurrency(session.currency)
    : currency;

  if (sessionCurrency !== currency) {
    throw new Error("Stripe currency does not match the credits snapshot");
  }

  const creditRecord = await MoneyCredit.findOne(
    withTenantId(tenantId, { user: userId }),
  );

  const alreadyApplied = (creditRecord?.transactions || []).some(
    (transaction) =>
      transaction?.type === "used" &&
      String(transaction.relatedOrder) === String(orderId),
  );

  if (alreadyApplied) {
    return { ok: true, skipped: true, reason: "already_applied" };
  }

  await moneyCreditService.incrementMoneyCredits({
    tenantId,
    userId,
    amount: -amount,
    currency,
    transaction: {
      type: MONEY_CREDIT_TRANSACTION_TYPE.USED,
      description: `Credits used as discount (order ${String(orderId)})`,
      relatedOrder: toObjectId(String(orderId)),
      idempotencyKey: `checkout-credit-discount:${String(orderId)}`,
    },
  });

  return {
    ok: true,
    skipped: false,
    deductedAmount: amount,
    orderId: String(orderId),
  };
};

export const processCreditPurchaseFromWebhook = async ({
  tenantId,
  order,
}: {
  tenantId: string;
  order: WebhookOrder;
}) => {
  if (!order?._id) {
    throw new Error("Missing order in credit webhook processor");
  }

  if (!order.createdBy) {
    throw new Error("Missing user on order for credit purchase");
  }

  const orderId = order._id;
  const amount = Number(order.creditPurchase?.amount || 0);
  const userId = order.createdBy;
  const currency = normalizeStudioCommerceCurrency(
    order.creditPurchase?.currency ?? order.currency,
  );

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid creditPurchase.amount on Order");
  }

  const creditRecord = await MoneyCredit.findOne(
    withTenantId(tenantId, { user: userId }),
  );

  const alreadyApplied = (creditRecord?.transactions || []).some(
    (transaction) =>
      transaction?.type === "added" &&
      String(transaction.relatedOrder) === String(orderId),
  );

  if (!alreadyApplied) {
    await moneyCreditService.incrementMoneyCredits({
      tenantId,
      userId,
      amount,
      currency,
      transaction: {
        type: MONEY_CREDIT_TRANSACTION_TYPE.ADDED,
        description: `Credits purchased (order ${String(orderId)})`,
        relatedOrder: toObjectId(String(orderId)),
        idempotencyKey: `checkout-credit-purchase:${String(orderId)}`,
      },
    });
  }

  return true;
};
