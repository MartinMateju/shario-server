import mongoose, { type ClientSession } from "mongoose";
import Order from "@/modules/order/order.model.js";
import { AppError } from "@/shared/http/AppError.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import {
  VoucherLifecycleError,
  reserveVoucherInSession,
  commitVoucherInSession,
  releaseVoucherInSession,
} from "@/modules/coupon/voucher-lifecycle.service.js";
import type { OrderVoucherRedemption } from "@/modules/order/order.types.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

const fail = (code: string, message: string): never => {
  throw new VoucherLifecycleError(code, message, 409);
};
export function normalizeCheckoutVoucherCode(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string" ||
    value.trim().length < 4 ||
    value.trim().length > 120 ||
    !/^[A-Za-z0-9-]+$/.test(value.trim())
  ) {
    throw new VoucherLifecycleError(
      "VOUCHER_CODE_INVALID",
      "Enter a valid voucher code.",
      400,
    );
  }
  return value.trim().toUpperCase();
}

/** Pure deterministic allocation over the final, server-priced invoice lines. */
export function buildVoucherCheckoutPlan({
  coupon,
  lineItems,
  currency,
  orderId = "quote",
  now = new Date(),
}: {
  coupon: any;
  lineItems: any[];
  currency: StudioCommerceCurrency;
  orderId?: string;
  now?: Date;
}) {
  if (!coupon) fail("VOUCHER_NOT_FOUND", "Voucher not found.");
  if (coupon.lifecycleVersion !== 1)
    fail(
      "VOUCHER_LEGACY_REDEMPTION_REQUIRED",
      "Redeem this legacy voucher to account credits first.",
    );
  if (coupon.refundReviewRequired)
    fail("VOUCHER_RECONCILIATION_REQUIRED", "This voucher needs review.");
  if (!coupon.isActive || coupon.revokedAt || coupon.redeemedAt)
    fail("VOUCHER_UNAVAILABLE", "Voucher is unavailable.");
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= now)
    fail("VOUCHER_EXPIRED", "Voucher has expired.");
  if (coupon.currencySnapshot !== currency)
    fail("VOUCHER_CURRENCY_MISMATCH", "Voucher and booking currencies differ.");
  if (
    coupon.reservedAt ||
    coupon.reservedOrder ||
    coupon.reservedBy ||
    coupon.reservedUntil
  )
    fail("VOUCHER_PAYMENT_PENDING", "Voucher has a pending redemption.");
  const experience = coupon.voucherTypeSnapshot === "experience";
  const settings = coupon.voucherSettingsSnapshot;
  let available = experience
    ? coupon.remainingQuantity - coupon.reservedQuantity
    : coupon.remainingValueMinor - coupon.reservedValueMinor;
  if (!Number.isSafeInteger(available) || available < 0)
    fail("VOUCHER_BALANCE_INCONSISTENT", "Voucher balance needs review.");
  const allocations: OrderVoucherRedemption[] = [];
  lineItems.forEach((line, lineIndex) => {
    const productId = String(line.product || "");
    if (
      !mongoose.isValidObjectId(productId) ||
      !Number.isSafeInteger(line.grossAmountMinor) ||
      line.grossAmountMinor <= 0
    )
      return;
    if (
      settings?.eligibleProductIds?.length &&
      !settings.eligibleProductIds.some((id: any) => String(id) === productId)
    )
      return;
    if (experience && String(settings?.experienceProductId) !== productId)
      return;
    const quantity = experience ? Math.min(available, line.quantity) : 0;
    if (
      experience &&
      (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
    )
      fail(
        "VOUCHER_QUANTITY_INVALID",
        "Experience quantity cannot be resolved.",
      );
    const appliedAmountMinor = experience
      ? Number(
          (BigInt(line.grossAmountMinor) * BigInt(quantity)) /
            BigInt(line.quantity),
        )
      : Math.min(available, line.grossAmountMinor);
    if (appliedAmountMinor < 1) return;
    const amountMinor = experience ? 0 : appliedAmountMinor;
    allocations.push({
      couponId: coupon._id,
      reservationId: `checkout:${orderId}:voucher:${lineIndex}`,
      lineIndex,
      eligibleProductId: line.product,
      amountMinor,
      quantity,
      appliedAmountMinor,
    });
    available -= experience ? quantity : amountMinor;
  });
  if (
    !allocations.length &&
    available === 0 &&
    (coupon.reservedValueMinor > 0 || coupon.reservedQuantity > 0)
  )
    fail(
      "VOUCHER_PAYMENT_PENDING",
      "This voucher is reserved for a pending payment. Complete or cancel that payment first.",
    );
  if (!allocations.length)
    fail(
      available === 0 ? "VOUCHER_INSUFFICIENT_BALANCE" : "VOUCHER_INELIGIBLE",
      available === 0
        ? "Voucher has no available balance."
        : "Voucher does not cover this booking.",
    );
  const totalAmountMinor = lineItems.reduce(
    (sum, line) => sum + line.grossAmountMinor,
    0,
  );
  if (!Number.isSafeInteger(totalAmountMinor) || totalAmountMinor < 1)
    fail("VOUCHER_AMOUNT_INVALID", "Booking total cannot be resolved.");
  const voucherAppliedMinor = allocations.reduce(
    (sum, row) => sum + row.appliedAmountMinor,
    0,
  );
  return {
    allocations,
    currency,
    totalAmountMinor,
    voucherAppliedMinor,
    remainingToPayMinor: totalAmountMinor - voucherAppliedMinor,
    remainingVoucherValueMinor: experience ? null : available,
    remainingVoucherQuantity: experience ? available : null,
    voucherType: experience ? "experience" : "value",
    cardRequired: totalAmountMinor > voucherAppliedMinor,
  };
}
export async function getVoucherCheckoutPlan({
  tenantId,
  voucherCode,
  lineItems,
  currency,
  orderId,
  session = null,
}: {
  tenantId: string;
  voucherCode: string;
  lineItems: any[];
  currency: StudioCommerceCurrency;
  orderId?: string;
  session?: ClientSession | null;
}) {
  const code = normalizeCheckoutVoucherCode(voucherCode);
  if (!code) fail("VOUCHER_CODE_INVALID", "Enter a voucher code.");
  const coupon = await Coupon.findOne({
    tenant: new mongoose.Types.ObjectId(tenantId),
    promoCode: code,
  })
    .session(session)
    .lean()
    .exec();
  return buildVoucherCheckoutPlan({ coupon, lineItems, currency, orderId });
}
export async function reserveCheckoutVouchers({
  tenantId,
  userId,
  orderId,
  currency,
  allocations,
  reviewAfter,
  session,
}: {
  tenantId: string;
  userId: string;
  orderId: string;
  currency: StudioCommerceCurrency;
  allocations: OrderVoucherRedemption[];
  reviewAfter?: Date;
  session: ClientSession;
}) {
  for (const row of allocations)
    await reserveVoucherInSession(
      {
        tenantId,
        couponId: row.couponId,
        operationId: row.reservationId,
        referenceId: orderId,
        eligibleProductId: String(row.eligibleProductId),
        currency,
        amountMinor: row.amountMinor,
        quantity: row.quantity,
        actorId: userId,
        reviewAfter,
      },
      session,
    );
}
export async function commitCheckoutVouchers({
  tenantId,
  order,
  session,
  paymentState,
}: {
  tenantId: string;
  order: any;
  session: ClientSession;
  paymentState: "paid" | "not_required";
}) {
  for (const row of order.voucherRedemptions ?? [])
    await commitVoucherInSession(
      {
        tenantId,
        couponId: row.couponId,
        reservationId: row.reservationId,
        operationId: `${row.reservationId}:commit`,
        referenceId: String(order._id),
        currency: order.currency,
        actorId: String(order.createdBy),
        paymentState,
      },
      session,
    );
}
export async function releaseCheckoutVouchers({
  tenantId,
  order,
  paymentState,
  reason,
}: {
  tenantId: string;
  order: any;
  paymentState: "expired" | "canceled" | "not_started";
  reason: string;
}) {
  if (!order?.voucherRedemptions?.length) return;
  await mongoose.connection.transaction(async (session) => {
    for (const row of order.voucherRedemptions)
      await releaseVoucherInSession(
        {
          tenantId,
          couponId: row.couponId,
          reservationId: row.reservationId,
          operationId: `${row.reservationId}:release`,
          referenceId: String(order._id),
          currency: order.currency,
          actorId: String(order.createdBy),
          paymentState,
          reason,
        },
        session,
      );
  });
}

export async function addOwnedVoucherPaymentContext(
  error: unknown,
  {
    tenantId,
    userId,
    voucherCode,
  }: { tenantId: string; userId: string; voucherCode: string },
): Promise<never> {
  if (
    error instanceof VoucherLifecycleError &&
    error.code === "VOUCHER_PAYMENT_PENDING"
  ) {
    const coupon = await Coupon.findOne({
      tenant: tenantId,
      promoCode: normalizeCheckoutVoucherCode(voucherCode),
    })
      .select("_id")
      .lean()
      .exec();
    const order = coupon
      ? await Order.findOne({
          tenant: tenantId,
          createdBy: userId,
          isPaid: false,
          status: "pending_order",
          voucherCheckoutReleasedAt: null,
          "voucherRedemptions.couponId": coupon._id,
        })
          .select("_id")
          .sort({ createdAt: -1 })
          .lean()
          .exec()
      : null;
    if (order)
      throw new AppError({
        code: error.code,
        statusCode: error.statusCode,
        message: error.message,
        details: { orderId: String(order._id) },
      });
  }
  throw error;
}
