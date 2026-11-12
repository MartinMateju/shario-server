import { Coupon, CouponOrder } from "./coupon.model.js";
import { COUPON_STATUS } from "./coupon.constants.js";
import {
  verifyVoucherPurchaseAccessToken,
  VOUCHER_ACCESS_TOKEN_PATTERN,
} from "./voucher-order-access.js";
import {
  getVoucherDeliverySummary,
  getVoucherDocumentDescriptors,
  getVoucherOrderDocument,
  requestVoucherCustomerResend,
} from "./voucher-delivery.service.js";
import { notFound } from "@/shared/http/httpErrors.js";
import { buildPhysicalDeliveryDto } from "./voucher-physical-delivery.policy.js";

type PurchaseProof = {
  tenantId: string;
  couponOrderId: string;
  accessToken: string;
};
const NOT_FOUND = {
  code: "VOUCHER_PURCHASE_NOT_FOUND",
  message: "Voucher purchase access was not found or has expired.",
};
const objectId = /^[a-f0-9]{24}$/i;
const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const requirePurchase = async ({
  tenantId,
  couponOrderId,
  accessToken,
}: PurchaseProof) => {
  if (
    !objectId.test(tenantId) ||
    !objectId.test(couponOrderId) ||
    !VOUCHER_ACCESS_TOKEN_PATTERN.test(accessToken || "")
  )
    notFound(NOT_FOUND);
  // Explicit tenant scoping is required even though a token is unguessable.
  const order = await CouponOrder.findOne({
    _id: couponOrderId,
    tenant: tenantId,
  })
    .select("+purchaseAccessTokenHash")
    .lean()
    .exec();
  if (
    !order ||
    !verifyVoucherPurchaseAccessToken({
      accessToken,
      tokenHash: order.purchaseAccessTokenHash,
      expiresAt: order.purchaseAccessExpiresAt,
    })
  )
    notFound(NOT_FOUND);
  return order;
};

const maskEmail = (value: unknown): string => {
  const [local, domain] = String(value || "").split("@");
  if (!local || !domain) return "";
  // The full buyer address never crosses the guest purchase API boundary.
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${domain.includes(".") ? domain.slice(domain.lastIndexOf(".")) : ""}`;
};

const buildStatus = async (order: any) => {
  const tenantId = String(order.tenant);
  const couponOrderId = String(order._id);
  const now = new Date();
  const refundState = String(order.refundState || "none");
  const refundedAmount = Number(order.refundedAmountMinor || 0);
  const paymentStatus =
    refundState === "manual_review" || order.refundFailureReviewRequired
      ? "review_required"
      : refundState === "revoked" || refundedAmount > 0
        ? "refunded"
        : order.paidAt
          ? "paid"
          : order.status === COUPON_STATUS.EXPIRED
            ? "expired"
            : "pending";
  const summary = await getVoucherDeliverySummary({ tenantId, couponOrderId });
  const customer = summary.customer;
  const deliveryStatus =
    paymentStatus === "refunded" || paymentStatus === "review_required"
      ? "suppressed"
      : customer?.status === "skipped" || customer?.status === "suppressed"
        ? "suppressed"
        : customer?.status || (order.customerEmailSent ? "sent" : "pending");
  let documents: ReturnType<typeof getVoucherDocumentDescriptors> = [];
  let revoked = false;
  let voucherExpired = Boolean(
    order.expiresAtSnapshot && new Date(order.expiresAtSnapshot) <= now,
  );
  if (paymentStatus === "paid") {
    const coupons = await Coupon.find({
      tenant: tenantId,
      order: couponOrderId,
    })
      .select("_id promoCode revokedAt refundReviewRequired expiresAt")
      .lean()
      .exec();
    revoked = coupons.some((coupon) =>
      Boolean(coupon.revokedAt || coupon.refundReviewRequired),
    );
    voucherExpired ||= coupons.some((coupon) =>
      Boolean(coupon.expiresAt && new Date(coupon.expiresAt) <= now),
    );
    const savedIds = new Set((order.coupons || []).map(String));
    const savedCodes = new Set(order.promoCodesSnapshot || []);
    const issued =
      Boolean(order.processedAt) &&
      Number.isInteger(order.quantity) &&
      order.quantity > 0 &&
      savedIds.size === order.quantity &&
      coupons.length === order.quantity &&
      coupons.every((coupon) => savedIds.has(String(coupon._id))) &&
      Array.isArray(order.promoCodesSnapshot) &&
      order.promoCodesSnapshot.length === order.quantity &&
      savedCodes.size === order.quantity &&
      coupons.every((coupon) => savedCodes.has(coupon.promoCode));
    if (issued && !revoked) documents = getVoucherDocumentDescriptors(order);
  }
  const day = now.toISOString().slice(0, 10);
  const cooldown = order.deliveryResendRequestedAt
    ? new Date(
        new Date(order.deliveryResendRequestedAt).getTime() + 5 * 60 * 1000,
      )
    : null;
  const dailyLimitReached =
    order.deliveryResendDay === day &&
    Number(order.deliveryResendDayCount || 0) >= 5;
  const nextDay = new Date(`${day}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const resendAvailableAt =
    [dailyLimitReached ? nextDay : null, cooldown]
      .filter((date): date is Date => Boolean(date && date > now))
      .sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const terminalDelivery = customer
    ? customer.status === "sent" ||
      customer.status === "ambiguous" ||
      (customer.status === "failed" && !customer.nextAttemptAt)
    : Boolean(order.customerEmailSent);
  const canResend =
    paymentStatus === "paid" &&
    documents.length > 0 &&
    !voucherExpired &&
    terminalDelivery &&
    !resendAvailableAt;
  const status =
    paymentStatus === "pending"
      ? "pending_payment"
      : paymentStatus !== "paid"
        ? paymentStatus
        : revoked
          ? "revoked"
          : documents.length > 0
            ? "ready"
            : "processing";
  return {
    status,
    paymentStatus,
    deliveryStatus: revoked ? "suppressed" : deliveryStatus,
    deliveryNextAttemptAt: iso(customer?.nextAttemptAt),
    productName: String(order.productNameSnapshot || "Voucher"),
    quantity: Number(order.quantity || 0),
    currency: String(order.currencySnapshot || ""),
    total: Number(order.totalSnapshot || 0),
    maskedEmail: maskEmail(order.email),
    voucherExpiresAt: iso(order.expiresAtSnapshot),
    voucherExpired,
    accessExpiresAt: iso(order.purchaseAccessExpiresAt),
    checkoutExpiresAt: iso(order.checkoutExpiresAt),
    documents,
    physicalDelivery: buildPhysicalDeliveryDto(order, undefined, { public: true }),
    canResend,
    resendAvailableAt: iso(resendAvailableAt),
  };
};

export const voucherPurchaseService = {
  async status(proof: PurchaseProof) {
    return buildStatus(await requirePurchase(proof));
  },

  async download(proof: PurchaseProof & { index: number }) {
    await requirePurchase(proof);
    // The document service checks paid/refund/code state again after rendering.
    return getVoucherOrderDocument({
      tenantId: proof.tenantId,
      couponOrderId: proof.couponOrderId,
      index: proof.index,
    });
  },

  async resend(proof: PurchaseProof) {
    await requirePurchase(proof);
    // Recipient and cooldown are enforced by the transactional delivery service;
    // the guest cannot provide an address, a code, or a replacement design.
    await requestVoucherCustomerResend({
      tenantId: proof.tenantId,
      couponOrderId: proof.couponOrderId,
    });
    return buildStatus(await requirePurchase(proof));
  },
};
