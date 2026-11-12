import { couponAmountToMinorUnits } from "./coupon.utils.js";
import { hasExactIssuedVouchers } from "./voucher-management-policy.js";

export type PhysicalDeliveryStatus =
  | "awaiting_payment"
  | "awaiting_dispatch"
  | "dispatched"
  | "cancelled"
  | "review_required";

const legacyDispatchedStatuses = ["shipped_coupon", "shipped_coupon_order"];
const iso = (value: any): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export const physicalDeliveryStatus = (order: any): PhysicalDeliveryStatus | null => {
  if (!order.sendPost) return null;
  // Posting is a historical fact, including if a refund happens afterwards.
  if (order.dispatchedAt || legacyDispatchedStatuses.includes(order.status)) return "dispatched";
  if (order.refundState === "manual_review" || order.refundFailureReviewRequired) return "review_required";
  if (
    order.refundState === "revoked" ||
    Number(order.refundedAmountMinor || 0) > 0 ||
    (!order.paidAt && order.status === "expired_coupon_payment")
  ) return "cancelled";
  return order.paidAt ? "awaiting_dispatch" : "awaiting_payment";
};

// Match the order-derived status exactly; live code checks belong to dispatch.
export const physicalStatusFilter = (
  status: PhysicalDeliveryStatus | "all",
): Record<string, any> => {
  if (status === "all") return {};
  const dispatched = { $or: [
    { dispatchedAt: { $ne: null } },
    { status: { $in: legacyDispatchedStatuses } },
  ] };
  const review = { $or: [
    { refundState: "manual_review" },
    { refundFailureReviewRequired: true },
  ] };
  const cancelled = { $or: [
    { refundState: "revoked" },
    { refundedAmountMinor: { $gt: 0 } },
    { paidAt: null, status: "expired_coupon_payment" },
  ] };
  const clauses: Record<string, any>[] = [{ sendPost: true }];
  if (status === "dispatched") clauses.push(dispatched);
  else {
    clauses.push({ $nor: [dispatched] });
    if (status === "review_required") clauses.push(review);
    else {
      clauses.push({ $nor: [review] });
      if (status === "cancelled") clauses.push(cancelled);
      else clauses.push(
        { $nor: [cancelled] },
        { paidAt: status === "awaiting_dispatch" ? { $ne: null } : null },
      );
    }
  }
  return { $and: clauses };
};

export const physicalDispatchBlocker = (order: any, coupons?: any[]): string | null => {
  const status = physicalDeliveryStatus(order);
  if (!status) return "not_requested";
  if (status === "dispatched") return "already_dispatched";
  if (status === "review_required" || status === "cancelled") return status;
  if (!order.paidAt) return "not_paid";
  if (!order.processedAt) return "not_issued";
  if (!coupons) return "details_required";
  if (!hasExactIssuedVouchers(order, coupons)) return "issuance_inconsistent";
  if (coupons.some((coupon) => coupon.revokedAt || coupon.refundReviewRequired)) return "voucher_unavailable";
  const now = new Date();
  if (
    (order.expiresAtSnapshot && new Date(order.expiresAtSnapshot) <= now) ||
    coupons.some((coupon) => coupon.expiresAt && new Date(coupon.expiresAt) <= now)
  ) return "voucher_expired";
  if (["firstname", "lastname", "street", "city", "postalCode"].some(
    (field) => typeof order[field] !== "string" || !order[field].trim(),
  )) return "address_incomplete";
  return null;
};

export const buildPhysicalDeliveryDto = (
  order: any,
  coupons?: any[],
  options?: { public?: boolean },
) => {
  let postageFeeMinor: number | null = null;
  try {
    postageFeeMinor = couponAmountToMinorUnits(
      Number(order.shippingFeeSnapshot || 0),
      order.currencySnapshot,
    );
  } catch {
    // Preserve unreadable legacy snapshots instead of inventing a currency value.
  }
  const common = {
    requested: Boolean(order.sendPost),
    status: physicalDeliveryStatus(order),
    postageFeeMinor,
    currency: order.currencySnapshot || null,
    dispatchedAt: iso(order.dispatchedAt),
  };
  if (options?.public) return common;
  const blockedReason = physicalDispatchBlocker(order, coupons);
  return {
    ...common,
    dispatchedBy: order.dispatchedBy ? String(order.dispatchedBy) : null,
    canDispatch: !blockedReason,
    blockedReason,
    address: order.sendPost ? {
      firstname: order.firstname || "",
      lastname: order.lastname || "",
      street: order.street || "",
      city: order.city || "",
      postalCode: order.postalCode || "",
      countryCode: order.countryCode || "",
    } : null,
  };
};
