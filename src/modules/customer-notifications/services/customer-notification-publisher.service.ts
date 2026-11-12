import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import LocationModel from "@/modules/location/location.model.js";
import UserModel from "@/modules/user/user.model.js";

import {
  CUSTOMER_NOTIFICATION_EVENTS,
  CUSTOMER_NOTIFICATION_EVENT_CATEGORY,
  CUSTOMER_NOTIFICATION_SEVERITIES,
} from "../customer-notification.constants.js";
import { customerNotificationRepository } from "../customer-notification.repository.js";
import type {
  CustomerNotificationCreateRecord,
  PublishCustomerNotificationInput,
} from "../customer-notification.types.js";
import {
  isSafeCustomerNotificationActionUrl,
  toCustomerNotificationDailyGroupKey,
} from "../customer-notification.utils.js";

const assertObjectId = (value: unknown, label: string): void => {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(`Customer notification ${label} is invalid.`);
  }
};

const assertBoundedText = (
  value: unknown,
  label: string,
  maximum: number,
): void => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  ) {
    throw new Error(
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
};

const validatePublishInput = (
  input: PublishCustomerNotificationInput,
): void => {
  assertObjectId(input.tenantId, "tenantId");
  assertObjectId(input.recipientUserId, "recipientUserId");
  if (input.locationId) assertObjectId(input.locationId, "locationId");

  if (!CUSTOMER_NOTIFICATION_EVENTS.includes(input.eventType)) {
    throw new Error("Customer notification event type is invalid.");
  }
  if (!CUSTOMER_NOTIFICATION_SEVERITIES.includes(input.severity)) {
    throw new Error("Customer notification severity is invalid.");
  }

  const canonicalCategory =
    CUSTOMER_NOTIFICATION_EVENT_CATEGORY[input.eventType];
  if (input.category && input.category !== canonicalCategory) {
    throw new Error(
      `Customer notification category must be ${canonicalCategory} for ${input.eventType}.`,
    );
  }

  assertBoundedText(input.title.cs, "Czech notification title", 180);
  assertBoundedText(input.title.en, "English notification title", 180);
  assertBoundedText(input.message.cs, "Czech notification message", 1_000);
  assertBoundedText(input.message.en, "English notification message", 1_000);
  assertBoundedText(input.sourceType, "Notification source type", 80);
  assertBoundedText(input.sourceId, "Notification source id", 180);
  assertBoundedText(
    input.deduplicationKey,
    "Notification deduplication key",
    240,
  );
  if (input.groupKey) {
    assertBoundedText(input.groupKey, "Notification group key", 240);
  }
  if (!isSafeCustomerNotificationActionUrl(input.actionUrl ?? "")) {
    throw new Error(
      "Customer notification action URL must remain inside /portal.",
    );
  }
  if ((input.actionUrl?.trim().length ?? 0) > 500) {
    throw new Error(
      "Customer notification action URL must not exceed 500 characters.",
    );
  }
  if (
    input.occurredAt &&
    !Number.isFinite(new Date(input.occurredAt).getTime())
  ) {
    throw new Error("Customer notification occurrence date is invalid.");
  }

  const finalGroupKey = toCustomerNotificationDailyGroupKey(
    input.groupKey,
    input.occurredAt ?? new Date(),
  );
  if (finalGroupKey.length > 240) {
    throw new Error(
      "Customer notification daily group key must not exceed 240 characters.",
    );
  }
};

const recipientExists = async (
  input: PublishCustomerNotificationInput,
): Promise<boolean> => {
  const query = UserModel.findOne({
    _id: new mongoose.Types.ObjectId(input.recipientUserId),
    tenant: new mongoose.Types.ObjectId(input.tenantId),
    isAccessGranted: true,
  }).select("_id");
  if (input.session) query.session(input.session);
  return Boolean(await query.lean().exec());
};

const locationBelongsToTenant = async (
  input: PublishCustomerNotificationInput,
): Promise<boolean> => {
  if (!input.locationId) return true;

  const query = LocationModel.exists({
    _id: new mongoose.Types.ObjectId(input.locationId),
    tenant: new mongoose.Types.ObjectId(input.tenantId),
  });
  if (input.session) query.session(input.session);
  return Boolean(await query.exec());
};

const toCreateRecord = (
  input: PublishCustomerNotificationInput,
): CustomerNotificationCreateRecord => {
  const occurredAt = input.occurredAt ?? new Date();

  return {
    tenantId: input.tenantId,
    recipientUserId: input.recipientUserId,
    locationId: input.locationId ?? null,
    eventType: input.eventType,
    category: CUSTOMER_NOTIFICATION_EVENT_CATEGORY[input.eventType],
    severity: input.severity,
    title: {
      cs: input.title.cs.trim(),
      en: input.title.en.trim(),
    },
    message: {
      cs: input.message.cs.trim(),
      en: input.message.en.trim(),
    },
    actionUrl: input.actionUrl?.trim() ?? "",
    sourceType: input.sourceType.trim(),
    sourceId: input.sourceId.trim(),
    deduplicationKey: input.deduplicationKey.trim(),
    groupKey: toCustomerNotificationDailyGroupKey(input.groupKey, occurredAt),
    occurredAt,
  };
};

export const publishCustomerNotification = async (
  input: PublishCustomerNotificationInput,
) => {
  validatePublishInput(input);
  // MongoDB transactions do not support parallel operations on one session.
  const hasRecipient = await recipientExists(input);
  const hasLocation = hasRecipient
    ? await locationBelongsToTenant(input)
    : false;
  if (!hasRecipient || !hasLocation) {
    return {
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    };
  }

  const result = await customerNotificationRepository.upsertMany(
    [toCreateRecord(input)],
    { session: input.session ?? null },
  );

  return {
    eligibleRecipientCount: 1,
    createdCount: result.createdCount,
    duplicateCount: Math.max(1 - result.createdCount, 0),
  };
};

/**
 * Use only after the business transaction has committed. Transactional
 * producers should call publishCustomerNotification with their ClientSession
 * so both records commit or roll back together.
 */
export const publishCustomerNotificationSafely = async (
  input: PublishCustomerNotificationInput,
) => {
  try {
    return {
      ok: true as const,
      ...(await publishCustomerNotification(input)),
    };
  } catch (error) {
    try {
      logger.error(
        {
          err: error,
          tenantId: input.tenantId,
          recipientUserId: input.recipientUserId,
          eventType: input.eventType,
          sourceType: input.sourceType,
        },
        "Customer notification publishing failed.",
      );
    } catch {
      // Best-effort publishing must not reject because logging is unavailable.
    }

    return {
      ok: false as const,
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    };
  }
};
