import { logger } from "@/config/logger.js";
import { COUPON_STATUS } from "./coupon.constants.js";
import { CouponOrder } from "./coupon.model.js";
import { couponService } from "./coupon.service.js";

/** Recover verified payments if issuance crashed before committing its outbox. */
export const reconcilePaidVoucherPurchases = async ({
  limit = 25,
}: { limit?: number } = {}) => {
  const now = new Date();
  const orders = await CouponOrder.find({
    status: COUPON_STATUS.PENDING_PAYMENT,
    paidAt: { $ne: null },
    processedAt: null,
    refundState: { $in: [null, "none"] },
    refundedAmountMinor: { $in: [null, 0] },
    $or: [
      { isProcessing: false },
      { processingLeaseExpiresAt: null },
      { processingLeaseExpiresAt: { $lte: now } },
    ],
  })
    .select("_id tenant stripeSessionId stripePaymentIntentId paidAt")
    .sort({ updatedAt: 1, _id: 1 })
    .limit(Math.max(1, Math.min(100, Math.trunc(limit) || 25)))
    .lean()
    .exec();

  let completed = 0;
  let failed = 0;
  for (const order of orders) {
    try {
      if (
        await couponService.finalizePaidCouponOrder({
          tenantId: String(order.tenant),
          couponOrderId: String(order._id),
          sessionId: order.stripeSessionId || undefined,
          paymentIntentId: order.stripePaymentIntentId || undefined,
          paidAt: order.paidAt || undefined,
        })
      )
        completed += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        {
          err: error,
          tenantId: String(order.tenant),
          couponOrderId: String(order._id),
        },
        "Confirmed voucher payment awaits issuance retry.",
      );
    }
  }
  return { examined: orders.length, completed, failed };
};
