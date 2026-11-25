import type { ManagementProduct } from "./dashboard-management.types.js";
import type { ReportPeriod } from "@/modules/reports/reports.types.js";
import { inManagementPeriod, managementDate, managementId } from "./dashboard-management.calculations.js";

/** A purchase is one settled order containing a product, independent of service completion. */
export const calculateManagementPurchases = ({ orders, vouchers = [], period, asOf, now, locationIds, wholeTenant }: {
  orders: any[];
  vouchers?: any[];
  period: ReportPeriod;
  asOf: Date;
  now: Date;
  locationIds: string[];
  wholeTenant: boolean;
}) => {
  const products = new Map<string, ManagementProduct & { purchaseCount: number }>();
  let complete = true;
  for (const order of orders) {
    if (order.isPaid !== true || order.status !== "processed_order") continue;
    const paidAt = managementDate(order.paidAt);
    if (!paidAt) { complete = false; continue; }
    if (!inManagementPeriod(paidAt, period) || paidAt >= asOf) continue;
    // Generic wallet top-ups have no product identity. Catalog credit packs are
    // product purchases; redemption checkouts can also be purchases with zero new cash.
    if (Number(order.creditPurchase?.amount ?? 0) > 0 &&
      !(order.lineItems ?? []).some((line: any) => managementId(line.product))) continue;
    if (order.refund?.reviewRequired) { complete = false; continue; }
    const cumulativeRefund = Number(order.refund?.succeededAmountMinor ?? 0) > 0 ||
      Number(order.pieceCheckout?.refundedAmountMinor ?? 0) > 0 ||
      (order.waitlistRefund?.status === "succeeded" && Number(order.waitlistRefund.amountMinor) > 0);
    if (asOf < now && (cumulativeRefund || order.pieceCheckout?.state === "refunded")) {
      complete = false; continue;
    }
    if (order.pieceCheckout?.state === "refunded" || order.refund?.status === "full") continue;
    const specializedRefund = Number(order.pieceCheckout?.refundedAmountMinor ?? 0) +
      (order.waitlistRefund?.status === "succeeded" ? Number(order.waitlistRefund.amountMinor ?? 0) : 0);
    if (specializedRefund > 0 && specializedRefund >= Number(order.paidAmountMinor)) continue;
    // Partial unallocated refunds retain a purchase event, but cannot establish net units.
    if (cumulativeRefund) complete = false;
    const lines = order.lineItems ?? [];
    if (!lines.length) { complete = false; continue; }
    const perOrder = new Map<string, { name: string; quantity: number }>();
    const cancelledByBooking = new Map<string, number>();
    for (const event of order.courseCancellations ?? []) {
      const at = managementDate(event.refundedAt);
      if (!at) { complete = false; continue; }
      if (at >= asOf) continue;
      const id = managementId(event.bookingId);
      if (!Number.isSafeInteger(event.quantity) || event.quantity < 0) { complete = false; continue; }
      cancelledByBooking.set(id, (cancelledByBooking.get(id) ?? 0) + event.quantity);
    }
    for (const line of lines) {
      const locations = (line.locationIds ?? []).map(managementId);
      if (!wholeTenant) {
        if (!locations.length) { complete = false; continue; }
        if (locations.every((id: string) => !locationIds.includes(id))) continue;
        if (locations.some((id: string) => !locationIds.includes(id))) { complete = false; continue; }
      }
      const product = managementId(line.product);
      // Never conflate different legacy products that share a display description.
      if (!product || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) { complete = false; continue; }
      const bookingId = managementId(line.booking);
      const removed = Math.min(line.quantity, cancelledByBooking.get(bookingId) ?? 0);
      cancelledByBooking.set(bookingId, (cancelledByBooking.get(bookingId) ?? 0) - removed);
      const quantity = line.quantity - removed;
      if (quantity <= 0) continue;
      const existing = perOrder.get(product) ?? { name: String(line.description || product), quantity: 0 };
      existing.quantity += quantity;
      perOrder.set(product, existing);
    }
    for (const [id, line] of perOrder) {
      const product = products.get(id) ?? { id, name: line.name, quantity: 0, purchaseCount: 0, revenueMinor: null };
      product.quantity += line.quantity;
      product.purchaseCount++;
      products.set(id, product);
    }
  }
  // Voucher purchases live outside ordinary Order.lineItems. They are workspace
  // purchases: no reliable selected-studio allocation exists on CouponOrder.
  if (!wholeTenant && vouchers.length) complete = false;
  for (const voucher of wholeTenant ? vouchers : []) {
    if (!["processed_coupon", "shipped_coupon"].includes(voucher.status)) continue;
    const paidAt = managementDate(voucher.paidAt);
    if (!paidAt) { complete = false; continue; }
    if (!inManagementPeriod(paidAt, period) || paidAt >= asOf) continue;
    if (voucher.refundFailureReviewRequired || voucher.refundState === "manual_review") {
      complete = false; continue;
    }
    const refunded = voucher.refundedAmountMinor ?? 0;
    if (!Number.isSafeInteger(refunded) || refunded < 0) { complete = false; continue; }
    if (asOf < now && (refunded > 0 || voucher.refundState === "revoked")) {
      complete = false; continue;
    }
    if (voucher.refundState === "revoked") continue;
    if (refunded > 0) {
      if (!Number.isSafeInteger(voucher.expectedAmountMinor) || voucher.expectedAmountMinor < refunded) {
        complete = false; continue;
      }
      if (refunded === voucher.expectedAmountMinor) continue;
      complete = false; // Partial refunds have no per-voucher unit allocation.
    }
    const id = managementId(voucher.product);
    if (!id || !Number.isSafeInteger(voucher.quantity) || voucher.quantity <= 0) {
      complete = false; continue;
    }
    const product = products.get(id) ?? {
      id, name: String(voucher.productNameSnapshot || id), quantity: 0, purchaseCount: 0, revenueMinor: null,
    };
    product.quantity += voucher.quantity;
    product.purchaseCount++;
    products.set(id, product);
  }
  return { complete, items: [...products.values()].sort((a, b) =>
    b.purchaseCount - a.purchaseCount || b.quantity - a.quantity || a.id.localeCompare(b.id)).slice(0, 3) };
};
