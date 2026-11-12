import { isMongoDuplicateKeyError } from "@/infrastructure/database/mongo-errors.js";

import {
  TENANT_BILLING_EMAIL_MAX_ATTEMPTS,
  TENANT_BILLING_EMAIL_PROCESSING_TIMEOUT_MINUTES,
  TENANT_BILLING_EMAIL_STATUS,
} from "./tenant-subscription.email.constants.js";
import TenantBillingEmailDeliveryModel from "./tenant-subscription.email.schema.js";
import type {
  TenantBillingEmailDeliveryDocument,
  TenantBillingEmailLocale,
  TenantBillingEmailPayload,
  TenantBillingEmailType,
} from "./tenant-subscription.email.types.js";

export const enqueueTenantBillingEmailDelivery = async ({
  deliveryKey,
  tenantId,
  type,
  priority,
  recipient,
  locale,
  payload,
}: {
  deliveryKey: string;
  tenantId: string;
  type: TenantBillingEmailType;
  priority: number;
  recipient: string;
  locale: TenantBillingEmailLocale;
  payload: TenantBillingEmailPayload;
}): Promise<void> => {
  try {
    const delivery = await TenantBillingEmailDeliveryModel.findOneAndUpdate(
      { deliveryKey },
      {
        $setOnInsert: {
          deliveryKey,
          tenant: tenantId,
          type,
          priority,
          recipient,
          locale,
          payload,
          status: TENANT_BILLING_EMAIL_STATUS.PENDING,
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    ).exec();

    if (
      delivery &&
      priority > delivery.priority &&
      (delivery.status === TENANT_BILLING_EMAIL_STATUS.PENDING ||
        delivery.status === TENANT_BILLING_EMAIL_STATUS.FAILED)
    ) {
      await TenantBillingEmailDeliveryModel.updateOne(
        {
          _id: delivery._id,
          priority: { $lt: priority },
          status: {
            $in: [
              TENANT_BILLING_EMAIL_STATUS.PENDING,
              TENANT_BILLING_EMAIL_STATUS.FAILED,
            ],
          },
        },
        {
          $set: {
            type,
            priority,
            recipient,
            locale,
            payload,
            status: TENANT_BILLING_EMAIL_STATUS.PENDING,
            nextAttemptAt: new Date(),
          },
        },
      ).exec();
    }
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      return;
    }

    throw error;
  }
};

export const claimNextTenantBillingEmailDelivery = async (
  now = new Date(),
): Promise<TenantBillingEmailDeliveryDocument | null> => {
  const staleBefore = new Date(
    now.getTime() - TENANT_BILLING_EMAIL_PROCESSING_TIMEOUT_MINUTES * 60 * 1000,
  );

  return TenantBillingEmailDeliveryModel.findOneAndUpdate(
    {
      attempts: { $lt: TENANT_BILLING_EMAIL_MAX_ATTEMPTS },
      $or: [
        {
          status: {
            $in: [
              TENANT_BILLING_EMAIL_STATUS.PENDING,
              TENANT_BILLING_EMAIL_STATUS.FAILED,
            ],
          },
          nextAttemptAt: { $lte: now },
        },
        {
          status: TENANT_BILLING_EMAIL_STATUS.PROCESSING,
          processingStartedAt: { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        status: TENANT_BILLING_EMAIL_STATUS.PROCESSING,
        processingStartedAt: now,
      },
      $unset: { lastError: 1 },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
  ).exec();
};

export const markTenantBillingEmailSent = async (
  deliveryId: string,
  providerMessageId?: string,
): Promise<void> => {
  await TenantBillingEmailDeliveryModel.updateOne(
    { _id: deliveryId },
    {
      $set: {
        status: TENANT_BILLING_EMAIL_STATUS.SENT,
        sentAt: new Date(),
        providerMessageId,
      },
      $unset: {
        processingStartedAt: 1,
        lastError: 1,
      },
    },
  ).exec();
};

export const markTenantBillingEmailFailed = async (
  delivery: TenantBillingEmailDeliveryDocument,
  error: unknown,
): Promise<void> => {
  const message =
    error instanceof Error ? error.message : "Unknown billing email error.";
  const delayMinutes = Math.min(
    360,
    5 * 2 ** Math.max(0, delivery.attempts - 1),
  );

  await TenantBillingEmailDeliveryModel.updateOne(
    { _id: delivery._id },
    {
      $set: {
        status: TENANT_BILLING_EMAIL_STATUS.FAILED,
        lastError: message.slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60 * 1000),
      },
      $unset: { processingStartedAt: 1 },
    },
  ).exec();
};
