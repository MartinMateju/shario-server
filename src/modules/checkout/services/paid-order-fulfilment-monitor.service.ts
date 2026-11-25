import { logger } from "@/config/logger.js";
import { ORDER_STATUS } from "@/modules/order/order.constants.js";
import Order from "@/modules/order/order.model.js";

const DEFAULT_STUCK_AFTER_MINUTES = 15;
const REPORT_LIMIT = 50;

/**
 * Card orders are fulfilled by the Stripe webhook. If fulfilment keeps
 * failing, the order stays paid but pending and the customer has no booking,
 * credit or voucher. Nothing else surfaces that state, so report it at error
 * level on every run until someone resolves it. Point log alerting at the
 * event=PAID_ORDER_NOT_FULFILLED. The generic `code` field is redacted by the
 * logger because it can contain customer verification or access codes.
 */
export const reportPaidUnfulfilledOrders = async ({
  now = new Date(),
  stuckAfterMinutes = DEFAULT_STUCK_AFTER_MINUTES,
}: {
  now?: Date;
  stuckAfterMinutes?: number;
} = {}): Promise<{ count: number }> => {
  const cutoff = new Date(now.getTime() - stuckAfterMinutes * 60_000);
  const orders = (await Order.find({
    isPaid: true,
    status: ORDER_STATUS.PENDING,
    updatedAt: { $lte: cutoff },
  })
    .select("_id tenant paidAt updatedAt stripe.lastProcessingError")
    .sort({ updatedAt: 1 })
    .limit(REPORT_LIMIT)
    .lean()
    .exec()) as any[];

  if (!orders.length) return { count: 0 };

  logger.error(
    {
      event: "PAID_ORDER_NOT_FULFILLED",
      count: orders.length,
      limit: REPORT_LIMIT,
      orders: orders.map((order) => ({
        orderId: String(order._id),
        tenantId: String(order.tenant),
        paidAt: order.paidAt ?? null,
        lastAttemptAt: order.updatedAt ?? null,
        lastProcessingError: order.stripe?.lastProcessingError ?? null,
      })),
    },
    "Paid orders are waiting for fulfilment; customers have paid without receiving their purchase.",
  );

  return { count: orders.length };
};
