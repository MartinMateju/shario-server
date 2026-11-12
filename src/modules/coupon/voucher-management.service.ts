import { Coupon, CouponOrder } from "./coupon.model.js";
import { VoucherLedger } from "./voucher-ledger.model.js";
import {
  getVoucherDeliverySummary,
  getVoucherDocumentDescriptors,
  getVoucherOrderDocument,
  requestVoucherCustomerResend,
} from "./voucher-delivery.service.js";
import {
  getVoucherManagementRefund,
  requestVoucherPurchaseRefund,
} from "./voucher-management-refund.service.js";
import {
  hasExactIssuedVouchers,
  purchaseRefundBlocker,
} from "./voucher-management-policy.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { voucherManagementDto } from "./voucher-record.js";
import { buildPhysicalDeliveryDto } from "./voucher-physical-delivery.policy.js";
export { voucherManagementDto } from "./voucher-record.js";

const iso = (value: any) => (value ? new Date(value).toISOString() : null);

const requireOrder = async (tenantId: string, couponOrderId: string) => {
  const order = await CouponOrder.findOne({
    tenant: tenantId,
    _id: couponOrderId,
  })
    .lean()
    .exec();
  if (!order)
    notFound({
      code: "VOUCHER_ORDER_NOT_FOUND",
      message: "Voucher order not found.",
    });
  return order;
};

async function orderDetail(tenantId: string, couponOrderId: string) {
  const order = await requireOrder(tenantId, couponOrderId);
  const [coupons, delivery, refundRequest] = await Promise.all([
    Coupon.find({ tenant: tenantId, order: couponOrderId })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec(),
    getVoucherDeliverySummary({ tenantId, couponOrderId }),
    getVoucherManagementRefund(tenantId, couponOrderId),
  ]);
  const deliverable = Boolean(
    order.paidAt &&
    order.processedAt &&
    (!order.refundState || order.refundState === "none") &&
    !order.refundedAmountMinor &&
    order.quantity <= 20 &&
    hasExactIssuedVouchers(order, coupons) &&
    !coupons.some((coupon) => coupon.revokedAt || coupon.refundReviewRequired),
  );
  const documents = deliverable ? getVoucherDocumentDescriptors(order) : [];
  const now = new Date();
  const expired =
    Boolean(order.expiresAtSnapshot && order.expiresAtSnapshot <= now) ||
    coupons.some((coupon) =>
      Boolean(coupon.expiresAt && coupon.expiresAt <= now),
    );
  const day = now.toISOString().slice(0, 10);
  const cooldown = order.deliveryResendRequestedAt
    ? new Date(order.deliveryResendRequestedAt.getTime() + 5 * 60_000)
    : null;
  const limit =
    order.deliveryResendDay === day && order.deliveryResendDayCount >= 5;
  const tomorrow = new Date(`${day}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const resendAvailableAt =
    [cooldown, limit ? tomorrow : null]
      .filter((date): date is Date => Boolean(date && date > now))
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const current = delivery.customer;
  const activeDelivery =
    current &&
    (["pending", "sending"].includes(current.status) ||
      (current.status === "failed" && current.nextAttemptAt));
  const refundBlocker = refundRequest
    ? "request_exists"
    : purchaseRefundBlocker(order, coupons);
  return {
    order: {
      id: String(order._id),
      email: order.email,
      productName: order.productNameSnapshot,
      quantity: order.quantity,
      total: order.totalSnapshot,
      currency: order.currencySnapshot,
      status: order.status,
      paidAt: iso(order.paidAt),
      processedAt: iso(order.processedAt),
      createdAt: iso(order.createdAt),
      refundState: order.refundState || "none",
      refundReviewReason: order.refundReviewReason || "",
      refundedAmountMinor: order.refundedAmountMinor || 0,
    },
    vouchers: coupons.map(voucherManagementDto),
    delivery,
    documents,
    physicalDelivery: buildPhysicalDeliveryDto(order, coupons),
    canResend: Boolean(
      deliverable && !expired && !activeDelivery && !resendAvailableAt,
    ),
    resendAvailableAt: iso(resendAvailableAt),
    refund: {
      eligible: !refundBlocker,
      blockedReason: refundBlocker,
      request: refundRequest,
    },
  };
}

export const voucherManagementService = {
  async detail(tenantId: string, couponId: string) {
    const coupon = await Coupon.findOne({ _id: couponId, tenant: tenantId })
      .lean()
      .exec();
    if (!coupon)
      notFound({ code: "VOUCHER_NOT_FOUND", message: "Voucher not found." });
    const rows = await VoucherLedger.find({
      tenant: tenantId,
      coupon: couponId,
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(101)
      .lean()
      .exec();
    return {
      voucher: voucherManagementDto(coupon),
      ledgerHasMore: rows.length > 100,
      ledger: rows.slice(0, 100).map((row) => ({
        id: String(row._id),
        kind: row.kind,
        amountMinor: row.amountMinor,
        quantity: row.quantity,
        currency: row.currency,
        referenceId: row.referenceId,
        actorId: row.actor ? String(row.actor) : null,
        reason: row.reason,
        createdAt: iso(row.createdAt),
      })),
    };
  },
  orderDetail,
  async download(tenantId: string, couponOrderId: string, index: number) {
    await requireOrder(tenantId, couponOrderId);
    return getVoucherOrderDocument({ tenantId, couponOrderId, index });
  },
  async resend(tenantId: string, couponOrderId: string) {
    await requireOrder(tenantId, couponOrderId);
    await requestVoucherCustomerResend({ tenantId, couponOrderId });
    return orderDetail(tenantId, couponOrderId);
  },
  async refund(input: Parameters<typeof requestVoucherPurchaseRefund>[0]) {
    await requestVoucherPurchaseRefund(input);
    return orderDetail(input.tenantId, input.couponOrderId);
  },
};
