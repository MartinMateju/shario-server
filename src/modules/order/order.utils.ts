import os from "node:os";
import { randomUUID } from "node:crypto";

import {
  ORDER_NOTIFICATION_MAX_RETRIES,
  ORDER_NOTIFICATION_STATUS,
  ORDER_NOTIFICATION_TYPE,
} from "./order.constants.js";
import type {
  OrderNotificationEvent,
  OrderWithCreatedByUser,
} from "./order.types.js";

export const getOrderNotificationLockOwner = (): string => {
  return `${os.hostname() || "host"}:${process.pid}:${randomUUID()}`;
};

export const safeString = (value: unknown): string => {
  return value === null || value === undefined ? "" : String(value);
};

export const getOrderNotificationEntry = (
  order: Pick<OrderWithCreatedByUser, "notificationLog">,
  type = ORDER_NOTIFICATION_TYPE.ORDER_CONFIRM,
): OrderNotificationEvent | null => {
  return Array.isArray(order.notificationLog)
    ? order.notificationLog.find((entry) => entry?.type === type) || null
    : null;
};

export const hasSentOrderNotification = (
  order: Pick<OrderWithCreatedByUser, "notificationLog">,
  type = ORDER_NOTIFICATION_TYPE.ORDER_CONFIRM,
): boolean => {
  return Boolean(
    order.notificationLog?.some(
      (entry) =>
        entry.type === type && entry.status === ORDER_NOTIFICATION_STATUS.SENT,
    ),
  );
};

export const isOrderNotificationRetryExhausted = (
  entry: OrderNotificationEvent | null,
): boolean => {
  return Boolean(
    entry &&
    (entry.status === ORDER_NOTIFICATION_STATUS.FAILED ||
      entry.status === ORDER_NOTIFICATION_STATUS.PROCESSING) &&
    (entry.retryable === false ||
      Number(entry.attempt || 1) >= ORDER_NOTIFICATION_MAX_RETRIES),
  );
};

export const isOrderNotificationPaymentEligible = (
  order: OrderWithCreatedByUser,
): boolean =>
  !order.legacyOrder &&
  order.isPaid === true &&
  order.status === "processed_order" &&
  (!order.pieceCheckout ||
    (order.pieceCheckout.state === "paid" &&
      Number(order.pieceCheckout.refundedAmountMinor || 0) === 0));

export const hasActiveOrderNotificationRecovery = (
  order: OrderWithCreatedByUser,
  now: Date,
): boolean =>
  Boolean(
    order.notificationRecovery?.id &&
    order.notificationRecovery.to &&
    new Date(order.notificationRecovery.expiresAt) > now,
  );
