import { hasVoucherBeenUsed } from "./voucher-lifecycle.service.js";
import {
  couponAmountToMinorUnits,
  normalizeCouponCurrency,
} from "./coupon.utils.js";

export const hasVoucherReservation = (coupon: any) =>
  Boolean(
    coupon.reservedAt ||
    coupon.reservedOrder ||
    coupon.reservedBy ||
    coupon.reservedUntil ||
    Number(coupon.reservedValueMinor || 0) > 0 ||
    Number(coupon.reservedQuantity || 0) > 0,
  );

export const issuedVoucherStatus = (coupon: any, now = new Date()) => {
  if (coupon.refundReviewRequired) return "review_required";
  if (coupon.revokedAt) return "revoked";
  if (coupon.redeemedAt || coupon.redeemedBy) return "redeemed";
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) return "expired";
  if (hasVoucherReservation(coupon)) return "reserved";
  if (coupon.lifecycleVersion === 1) {
    const remaining =
      coupon.voucherTypeSnapshot === "experience"
        ? coupon.remainingQuantity
        : coupon.remainingValueMinor;
    if (remaining === 0) return "redeemed";
    if (hasVoucherBeenUsed(coupon)) return "partially_redeemed";
  }
  return coupon.isActive ? "active" : "inactive";
};

export const hasExactIssuedVouchers = (order: any, coupons: any[]) => {
  const ids = new Set((order.coupons || []).map(String));
  const codes = new Set(order.promoCodesSnapshot || []);
  return (
    Number.isSafeInteger(order.quantity) &&
    order.quantity > 0 &&
    coupons.length === order.quantity &&
    ids.size === order.quantity &&
    codes.size === order.quantity &&
    order.promoCodesSnapshot?.length === order.quantity &&
    coupons.every(
      (coupon) => ids.has(String(coupon._id)) && codes.has(coupon.promoCode),
    )
  );
};

export const purchaseRefundBlocker = (
  order: any,
  coupons: any[],
): string | null => {
  if (!order.paidAt) return "not_paid";
  if (!order.processedAt) return "not_issued";
  if (
    !order.stripeConnectedAccountId?.startsWith("acct_") ||
    !order.stripePaymentIntentId?.startsWith("pi_") ||
    typeof order.stripeLivemode !== "boolean"
  )
    return "unsupported_payment";
  if (order.refundedAmountMinor > 0 || order.refundState === "revoked")
    return "already_refunded";
  if (
    order.refundState === "manual_review" ||
    order.refundFailureReviewRequired ||
    coupons.some((coupon) => coupon.refundReviewRequired)
  )
    return "review_required";
  if (!hasExactIssuedVouchers(order, coupons)) return "inconsistent_codes";
  if (coupons.some(hasVoucherBeenUsed)) return "used_voucher";
  if (coupons.some(hasVoucherReservation)) return "reserved_voucher";
  // A manually voided, unused code can still have its purchase refunded.
  if (coupons.some((coupon) => !coupon.isActive && !coupon.revokedAt))
    return "review_required";
  return null;
};

export const expectedVoucherPurchaseAmount = (order: any) => {
  const amount =
    order.expectedAmountMinor ||
    couponAmountToMinorUnits(
      order.totalSnapshot,
      normalizeCouponCurrency(order.currencySnapshot),
    );
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("Voucher purchase amount is invalid.");
  return amount;
};
