import {
  ORDER_CONFIRM_NOTIFICATION_TYPE,
  ORDER_NOTIFICATION_MAX_RETRIES,
  ORDER_NOTIFICATION_STATUS,
  ORDER_STATUS,
} from "./order.constants.js";

type OrderQuery = Record<string, unknown>;

export const buildPaidOrderNotificationBaseQuery = (): OrderQuery => ({
  isPaid: true,
  legacyOrder: { $ne: true },
  status: { $nin: [ORDER_STATUS.FAILED, ORDER_STATUS.CANCELLED] },
});

export const buildNotificationLockFreeQuery = (
  now: Date,
): OrderQuery => ({
  $or: [
    { "notificationLock.lockedUntil": null },
    { "notificationLock.lockedUntil": { $lte: now } },
    { notificationLock: { $exists: false } },
  ],
});

export const buildOrderNotificationRetryEligibleQuery = (
  retryCutoff: Date,
): OrderQuery => ({
  notificationLog: {
    $elemMatch: {
      type: ORDER_CONFIRM_NOTIFICATION_TYPE,
      status: ORDER_NOTIFICATION_STATUS.FAILED,
      attempt: { $lt: ORDER_NOTIFICATION_MAX_RETRIES },
      sentAt: { $lte: retryCutoff },
    },
  },
});