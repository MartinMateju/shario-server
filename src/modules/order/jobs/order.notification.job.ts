import { randomUUID } from "node:crypto";

import {
  ORDER_CONFIRM_NOTIFICATION_TYPE,
  ORDER_NOTIFICATION_FALLBACK_SEND_WINDOW_HOURS,
  ORDER_NOTIFICATION_MAX_RETRIES,
  ORDER_NOTIFICATION_RETRY_DELAY_MS,
  ORDER_NOTIFICATION_RETRY_WINDOW_HOURS,
  ORDER_NOTIFICATION_STATUS,
} from "@/modules/order/order.constants.js";
import {
  acquireOrderNotificationLock,
  findOrderForNotification,
  findOrderNotificationCandidates,
  markFirstOrderNotificationClaimed,
  markOrderNotificationExhausted,
  markOrderNotificationFailed,
  markOrderNotificationAmbiguous,
  markOrderNotificationProviderStarted,
  markOrderNotificationSent,
  markRetryOrderNotificationClaimed,
  releaseOrderNotificationLock,
} from "@/modules/order/order.repository.js";
import type {
  OrderNotificationEmailMeta,
  OrderWithCreatedByUser,
  PopulatedOrderUser,
} from "@/modules/order/order.types.js";
import {
  getOrderNotificationEntry,
  getOrderNotificationLockOwner,
  hasSentOrderNotification,
  hasActiveOrderNotificationRecovery,
  isOrderNotificationPaymentEligible,
  isOrderNotificationRetryExhausted,
  safeString,
} from "../order.utils.js";

import { logger } from "@/config/logger.js";
import { sendSystemPostmarkEmail } from "@/infrastructure/email/managed-email.service.js";
import { PostmarkRequestError } from "@/infrastructure/email/postmark.client.js";
import { sendNotificationEmail } from "@/modules/order/services/order.email.service.js";

const ADMIN_EMAIL =
  process.env.ORDER_NOTIFICATION_ADMIN_EMAIL || "support@shario.io";

const emailAdmin = async (
  subject: string,
  lines: Array<string | null | undefined>,
): Promise<void> => {
  try {
    await sendSystemPostmarkEmail({
      to: ADMIN_EMAIL,
      subject,
      text: lines.filter(Boolean).join("\n"),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to email order notification admin.");
  }
};

const notifyAdminRetryStarted = async ({
  orderId,
  userEmail,
  attempt,
  previousError,
}: {
  orderId: unknown;
  userEmail: string;
  attempt: number;
  previousError?: string | null;
}): Promise<void> => {
  await emailAdmin(
    `Retry order_confirm attempt ${attempt}/${ORDER_NOTIFICATION_MAX_RETRIES}`,
    [
      "Retrying order confirmation email.",
      `Order: ${safeString(orderId)}`,
      `User email: ${safeString(userEmail)}`,
      `Attempt: ${attempt}/${ORDER_NOTIFICATION_MAX_RETRIES}`,
      previousError ? `Previous error: ${safeString(previousError)}` : null,
      `Time: ${new Date().toISOString()}`,
    ],
  );
};

const notifyAdminRetriesExhausted = async ({
  orderId,
  userEmail,
  attempt,
  lastError,
}: {
  orderId: unknown;
  userEmail: string;
  attempt: number;
  lastError?: string | null;
}): Promise<void> => {
  await emailAdmin("order_confirm FAILED: max retries reached", [
    "Order confirmation email failed and reached max retries.",
    `Order: ${safeString(orderId)}`,
    `User email: ${safeString(userEmail)}`,
    `Attempts: ${attempt}/${ORDER_NOTIFICATION_MAX_RETRIES}`,
    lastError ? `Last error: ${safeString(lastError)}` : null,
    `Time: ${new Date().toISOString()}`,
  ]);
};

const getPopulatedUser = (
  order: OrderWithCreatedByUser,
): PopulatedOrderUser | null => {
  // Guest email is an immutable purchase contact, never an authentication
  // account. Do not replace it with a populated/internal identity.
  if (order.guestCourseCheckout?.version === 1) {
    return order.customer?.email ? order.customer : null;
  }
  const createdBy = order.createdBy;

  if (!createdBy || typeof createdBy !== "object" || !("email" in createdBy)) {
    return order.customer?.email ? order.customer : null;
  }

  return createdBy;
};

const isOutsideNotificationWindow = (
  order: OrderWithCreatedByUser,
  hasExistingEntry: boolean,
  now: Date,
): boolean => {
  if (hasActiveOrderNotificationRecovery(order, now)) return false;
  const refTime = order.paidAt
    ? new Date(order.paidAt)
    : new Date(order.createdAt);
  const windowHours = hasExistingEntry
    ? ORDER_NOTIFICATION_RETRY_WINDOW_HOURS
    : ORDER_NOTIFICATION_FALLBACK_SEND_WINDOW_HOURS;
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  return refTime < windowStart;
};

export const processPaidOrderNotifications = async (): Promise<void> => {
  const lockOwner = getOrderNotificationLockOwner();
  const now = new Date();
  const retryCutoff = new Date(
    now.getTime() - ORDER_NOTIFICATION_RETRY_DELAY_MS,
  );

  try {
    logger.info("Processing order confirmation notifications.");

    const candidates = await findOrderNotificationCandidates(now);

    if (!candidates.length) {
      return;
    }

    for (const candidate of candidates) {
      const orderId = candidate._id;

      const locked = await acquireOrderNotificationLock({
        orderId,
        lockOwner,
        now: new Date(),
      });

      if (!locked) {
        continue;
      }

      try {
        const order = await findOrderForNotification(orderId);

        if (!order || !isOrderNotificationPaymentEligible(order)) {
          continue;
        }

        const entry = getOrderNotificationEntry(
          order,
          ORDER_CONFIRM_NOTIFICATION_TYPE,
        );

        if (hasSentOrderNotification(order, ORDER_CONFIRM_NOTIFICATION_TYPE)) {
          continue;
        }

        if (entry?.status === ORDER_NOTIFICATION_STATUS.AMBIGUOUS) continue;

        // A crashed worker may already have submitted the message. Neither a
        // stale lease nor the final retry budget proves that it was not sent.
        const interruptedSubmission =
          entry?.status === ORDER_NOTIFICATION_STATUS.PROCESSING &&
          (entry.deliveryVersion !== 1 || entry.providerStartedAt);
        const unknownLegacyFailure =
          entry?.status === ORDER_NOTIFICATION_STATUS.FAILED &&
          entry.deliveryVersion !== 1 &&
          !/^connect ECONNREFUSED 127\.0\.0\.1:1025$/i.test(
            entry.error?.trim() || "",
          );
        if (entry && (interruptedSubmission || unknownLegacyFailure)) {
          await markOrderNotificationAmbiguous({
            orderId,
            lockOwner,
            claimId: entry.claimId || "",
            errorMessage:
              "Interrupted email submission; awaiting provider evidence or manual review.",
          });
          continue;
        }

        const user = getPopulatedUser(order);
        const to = order.notificationRecovery?.to || user?.email;
        if (!to) {
          logger.warn(
            { orderId: String(orderId) },
            "Order notification skipped because customer email is missing.",
          );
          continue;
        }
        const recipient = { ...user, email: to };

        if (isOutsideNotificationWindow(order, Boolean(entry), now)) {
          logger.info(
            { orderId: String(orderId) },
            "Order notification skipped because it is outside the allowed window.",
          );
          continue;
        }

        if (isOrderNotificationRetryExhausted(entry)) {
          const alreadyNotified =
            safeString(entry?.provider) === "exhausted" ||
            safeString(entry?.template) === "exhausted";

          if (!alreadyNotified) {
            const marked = await markOrderNotificationExhausted({
              orderId,
              lockOwner,
              claimId: entry?.claimId || "",
            });
            if (marked) {
              await notifyAdminRetriesExhausted({
                orderId,
                userEmail: to,
                attempt: Number(
                  entry?.attempt || ORDER_NOTIFICATION_MAX_RETRIES,
                ),
                lastError: entry?.error || null,
              });
            }
          }

          continue;
        }

        const claimTime = new Date();
        const claimId = randomUUID();
        let claimed: unknown = null;
        let isRetry = false;
        let retryAttemptNumber = 1;
        let previousError: string | null = null;

        const retryEligibleNow =
          entry &&
          (entry.status === ORDER_NOTIFICATION_STATUS.FAILED ||
            entry.status === ORDER_NOTIFICATION_STATUS.PROCESSING) &&
          entry.retryable !== false &&
          Number(entry.attempt || 1) < ORDER_NOTIFICATION_MAX_RETRIES &&
          entry.sentAt &&
          new Date(entry.sentAt) <= retryCutoff;

        if (!entry) {
          claimed = await markFirstOrderNotificationClaimed({
            orderId,
            lockOwner,
            to,
            claimTime,
            claimId,
          });
        } else if (retryEligibleNow) {
          isRetry = true;
          retryAttemptNumber = Math.max(2, Number(entry.attempt || 1) + 1);
          previousError = entry.error || null;

          claimed = await markRetryOrderNotificationClaimed({
            orderId,
            lockOwner,
            to,
            claimTime,
            retryCutoff,
            claimId,
          });

          if (claimed) {
            await notifyAdminRetryStarted({
              orderId,
              userEmail: to,
              attempt: retryAttemptNumber,
              previousError,
            });
          }
        }

        if (!claimed) {
          continue;
        }

        let meta: OrderNotificationEmailMeta | undefined;
        let providerStarted = false;
        try {
          meta = (await sendNotificationEmail({
            type: ORDER_CONFIRM_NOTIFICATION_TYPE,
            order,
            user: recipient,
            deliveryId: claimId,
            beforeSend: async () => {
              const active = await markOrderNotificationProviderStarted({
                orderId,
                lockOwner,
                claimId,
                now: new Date(),
              });
              if (!active) {
                throw new PostmarkRequestError(
                  "Order confirmation lease expired before email delivery.",
                  {
                    code: "ORDER_NOTIFICATION_LEASE_EXPIRED",
                    deliveryOutcome: "not_sent",
                  },
                );
              }
              providerStarted = true;
            },
          })) as OrderNotificationEmailMeta | undefined;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          if (
            providerStarted &&
            !(
              error instanceof PostmarkRequestError &&
              error.deliveryOutcome === "not_sent"
            )
          ) {
            await markOrderNotificationAmbiguous({
              orderId,
              lockOwner,
              claimId,
              errorMessage,
            });
            logger.error(
              { orderId: String(orderId) },
              "Order confirmation outcome is ambiguous; automatic retries stopped.",
            );
            continue;
          }

          const retryable = !(
            error instanceof PostmarkRequestError && error.permanent
          );

          await markOrderNotificationFailed({
            orderId,
            lockOwner,
            errorMessage,
            claimId,
            retryable,
          });

          const attempt = isRetry ? retryAttemptNumber : 1;

          if (!retryable || attempt >= ORDER_NOTIFICATION_MAX_RETRIES) {
            const marked = await markOrderNotificationExhausted({
              orderId,
              lockOwner,
              claimId,
            });
            if (marked) {
              await notifyAdminRetriesExhausted({
                orderId,
                userEmail: to,
                attempt,
                lastError: errorMessage,
              });
            }
          }
          continue;
        }

        // Keep the durable submission marker if persisting success fails. A
        // later scan quarantines it; the provider webhook can also settle it.
        try {
          await markOrderNotificationSent({
            orderId,
            lockOwner,
            claimId,
            provider: meta?.provider,
            providerMessageId: meta?.providerMessageId,
            template: meta?.template,
          });
        } catch (error) {
          logger.error(
            { err: error, orderId: String(orderId) },
            "Accepted order confirmation could not be finalized; do not resend.",
          );
        }
      } finally {
        await releaseOrderNotificationLock({ orderId, lockOwner });
      }
    }

    logger.info("Order confirmation notification run finished.");
  } catch (error) {
    logger.error({ err: error }, "Failed to process order notifications.");
  }
};

export const sendOutNotificationsAfterPayment = async (): Promise<void> => {
  await processPaidOrderNotifications();
};
