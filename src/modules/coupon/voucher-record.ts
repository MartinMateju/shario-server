import { hasVoucherBeenUsed } from "./voucher-lifecycle.service.js";
import { hasVoucherReservation, issuedVoucherStatus } from "./voucher-management-policy.js";
import { getProductNameSnapshot } from "./coupon.utils.js";

const iso = (value: any) => (value ? new Date(value).toISOString() : null);
const nullableNumber = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

export const voucherManagementDto = (coupon: any) => ({
  id: String(coupon._id),
  code: coupon.promoCode,
  productId: String(coupon.productId || coupon.product?._id || coupon.product || ""),
  type: coupon.voucherTypeSnapshot || "value",
  productName: getProductNameSnapshot(coupon.productNameSnapshot) || "Voucher",
  valueMinor: nullableNumber(coupon.valueMinorSnapshot),
  currency: coupon.currencySnapshot || null,
  remainingValueMinor: nullableNumber(coupon.remainingValueMinor),
  walletRedeemedValueMinor: nullableNumber(coupon.walletRedeemedValueMinor),
  remainingQuantity: nullableNumber(coupon.remainingQuantity),
  reservedValueMinor: Number(coupon.reservedValueMinor || 0),
  reservedQuantity: Number(coupon.reservedQuantity || 0),
  status: issuedVoucherStatus(coupon),
  expiresAt: iso(coupon.expiresAt),
  createdAt: iso(coupon.createdAt),
  revokedAt: iso(coupon.revokedAt),
  revocationReason: coupon.revocationReason || "",
  archivedAt: iso(coupon.archivedAt),
  archivedBy: coupon.archivedBy ? String(coupon.archivedBy) : null,
  canArchive: !coupon.archivedAt,
  canRestore: Boolean(coupon.archivedAt),
  orderId: coupon.order ? String(coupon.order?._id || coupon.order) : null,
  lifecycleVersion: coupon.lifecycleVersion || 0,
  canRevoke: Boolean(
    coupon.isActive &&
    !coupon.revokedAt &&
    !coupon.refundReviewRequired &&
    !hasVoucherBeenUsed(coupon) &&
    !hasVoucherReservation(coupon),
  ),
});
