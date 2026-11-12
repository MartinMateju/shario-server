import { isMongoDuplicateKeyError } from "@/infrastructure/database/mongo-errors.js";

import { STRIPE_EVENT_PROCESSING_TIMEOUT_MINUTES } from "./tenant-subscription.constants.js";
import StripeWebhookEventModel, {
  STRIPE_WEBHOOK_EVENT_STATUS,
} from "./tenant-subscription.webhook-event.schema.js";

export const claimStripeWebhookEvent = async ({
  eventId,
  type,
  stripeCreatedAt,
}: {
  eventId: string;
  type: string;
  stripeCreatedAt: number;
}): Promise<boolean> => {
  try {
    await StripeWebhookEventModel.create({
      eventId,
      type,
      stripeCreatedAt,
      status: STRIPE_WEBHOOK_EVENT_STATUS.PROCESSING,
      attempts: 1,
    });

    return true;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
  }

  const staleBefore = new Date(
    Date.now() - STRIPE_EVENT_PROCESSING_TIMEOUT_MINUTES * 60 * 1000,
  );

  const reclaimed = await StripeWebhookEventModel.findOneAndUpdate(
    {
      eventId,
      $or: [
        { status: STRIPE_WEBHOOK_EVENT_STATUS.FAILED },
        {
          status: STRIPE_WEBHOOK_EVENT_STATUS.PROCESSING,
          updatedAt: { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        status: STRIPE_WEBHOOK_EVENT_STATUS.PROCESSING,
        lastError: undefined,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  ).exec();

  return Boolean(reclaimed);
};

export const completeStripeWebhookEvent = async (
  eventId: string,
): Promise<void> => {
  await StripeWebhookEventModel.updateOne(
    { eventId },
    {
      $set: {
        status: STRIPE_WEBHOOK_EVENT_STATUS.PROCESSED,
        processedAt: new Date(),
      },
      $unset: { lastError: 1 },
    },
  ).exec();
};

export const failStripeWebhookEvent = async (
  eventId: string,
  error: unknown,
): Promise<void> => {
  const message =
    error instanceof Error ? error.message : "Unknown webhook processing error.";

  await StripeWebhookEventModel.updateOne(
    { eventId },
    {
      $set: {
        status: STRIPE_WEBHOOK_EVENT_STATUS.FAILED,
        lastError: message.slice(0, 2000),
      },
    },
  ).exec();
};
