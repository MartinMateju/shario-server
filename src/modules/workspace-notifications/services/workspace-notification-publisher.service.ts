import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import { TENANT_MEMBERSHIP_STATUS } from "@/modules/tenant-access/tenant-access.constants.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";

import {
  WORKSPACE_NOTIFICATION_EVENTS,
  WORKSPACE_NOTIFICATION_EVENT_CATEGORY,
  WORKSPACE_NOTIFICATION_EVENT_PREFERENCE,
  WORKSPACE_NOTIFICATION_SEVERITIES,
} from "../workspace-notification.constants.js";
import { workspaceNotificationRepository } from "../workspace-notification.repository.js";
import type {
  PublishWorkspaceNotificationInput,
  WorkspaceNotificationCreateRecord,
  WorkspaceNotificationRecipient,
} from "../workspace-notification.types.js";
import { isSafeWorkspaceNotificationActionUrl } from "../workspace-notification.utils.js";

const toObjectId = (value: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

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
  input: PublishWorkspaceNotificationInput,
): void => {
  for (const [value, label] of [
    [input.tenantId, "tenantId"],
    [input.actorUserId, "actorUserId"],
    [input.locationId, "locationId"],
  ] as const) {
    if (value && !mongoose.Types.ObjectId.isValid(value)) {
      throw new Error(`Workspace notification ${label} is invalid.`);
    }
  }

  for (const recipientUserId of input.recipientUserIds ?? []) {
    if (!mongoose.Types.ObjectId.isValid(recipientUserId)) {
      throw new Error("Workspace notification recipient user id is invalid.");
    }
  }
  for (const excludedUserId of input.excludedUserIds ?? []) {
    if (!mongoose.Types.ObjectId.isValid(excludedUserId)) {
      throw new Error("Workspace notification excluded user id is invalid.");
    }
  }

  if (!WORKSPACE_NOTIFICATION_EVENTS.includes(input.eventType)) {
    throw new Error("Workspace notification event type is invalid.");
  }
  if (!WORKSPACE_NOTIFICATION_SEVERITIES.includes(input.severity)) {
    throw new Error("Workspace notification severity is invalid.");
  }
  const canonicalCategory =
    WORKSPACE_NOTIFICATION_EVENT_CATEGORY[input.eventType];
  if (input.category && input.category !== canonicalCategory) {
    throw new Error(
      `Workspace notification category must be ${canonicalCategory} for ${input.eventType}.`,
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
  if (!isSafeWorkspaceNotificationActionUrl(input.actionUrl ?? "")) {
    throw new Error(
      "Workspace notification action URL must remain inside /app.",
    );
  }
  if (
    input.occurredAt &&
    !Number.isFinite(new Date(input.occurredAt).getTime())
  ) {
    throw new Error("Workspace notification occurrence date is invalid.");
  }
};

const loadCandidateRecipients = async (
  input: PublishWorkspaceNotificationInput,
): Promise<WorkspaceNotificationRecipient[]> => {
  if (input.recipientUserIds && input.recipientUserIds.length === 0) return [];

  const query = TenantMembershipModel.find({
    tenant: toObjectId(input.tenantId),
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
    ...(input.recipientUserIds
      ? {
          user: {
            $in: [...new Set(input.recipientUserIds)].map(toObjectId),
          },
        }
      : {}),
  }).select("user");
  if (input.session) query.session(input.session);

  const memberships = await query.lean().exec();
  const excluded = new Set(input.excludedUserIds ?? []);
  const recipients: WorkspaceNotificationRecipient[] = [];

  for (const membership of memberships) {
    const userId = String(membership.user);
    if (excluded.has(userId)) continue;

    const access = await resolveWorkspaceAccessForUser({
      tenantId: input.tenantId,
      userId,
      session: input.session ?? null,
    });
    if (!access || access.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) continue;
    if (
      input.requiredPermission &&
      !hasWorkspacePermission(access, input.requiredPermission)
    ) {
      continue;
    }
    if (
      input.locationId &&
      !canAccessWorkspaceLocation(access, input.locationId)
    ) {
      continue;
    }

    const preferenceKey =
      input.preferenceKey === undefined
        ? (WORKSPACE_NOTIFICATION_EVENT_PREFERENCE[
            input.eventType as keyof typeof WORKSPACE_NOTIFICATION_EVENT_PREFERENCE
          ] ?? null)
        : input.preferenceKey;
    const preferences = access.preferences.notifications;
    if (preferences.inApp === false) continue;
    if (preferenceKey && preferences[preferenceKey] === false) continue;

    recipients.push({ userId, preferences });
  }

  return recipients;
};

export const toWorkspaceNotificationDailyGroupKey = (
  groupKey: string | undefined,
  occurredAt: Date,
): string => {
  const normalized = groupKey?.trim() ?? "";
  if (!normalized) return "";
  if (/:\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  return `${normalized}:${occurredAt.toISOString().slice(0, 10)}`;
};

const toCreateRecord = (
  input: PublishWorkspaceNotificationInput,
  recipientUserId: string,
): WorkspaceNotificationCreateRecord => {
  const occurredAt = input.occurredAt ?? new Date();

  return {
  tenantId: input.tenantId,
  recipientUserId,
  locationId: input.locationId ?? null,
  actorUserId: input.actorUserId ?? null,
  eventType: input.eventType,
  category: WORKSPACE_NOTIFICATION_EVENT_CATEGORY[input.eventType],
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
  requiredPermission: input.requiredPermission ?? null,
  deduplicationKey: input.deduplicationKey.trim(),
  groupKey: toWorkspaceNotificationDailyGroupKey(input.groupKey, occurredAt),
  occurredAt,
  };
};

export const publishWorkspaceNotification = async (
  input: PublishWorkspaceNotificationInput,
) => {
  validatePublishInput(input);
  const recipients = await loadCandidateRecipients(input);
  const result = await workspaceNotificationRepository.upsertMany(
    recipients.map((recipient) => toCreateRecord(input, recipient.userId)),
    { session: input.session ?? null },
  );

  return {
    eligibleRecipientCount: recipients.length,
    createdCount: result.createdCount,
    duplicateCount: Math.max(recipients.length - result.createdCount, 0),
  };
};

/**
 * Post-commit business hooks must not make their primary operation fail when
 * notification fan-out is unavailable. Validation, recipient lookup and
 * persistence failures are logged and reduced to a typed failure result.
 */
export const publishWorkspaceNotificationSafely = async (
  input: PublishWorkspaceNotificationInput,
) => {
  try {
    return {
      ok: true as const,
      ...(await publishWorkspaceNotification(input)),
    };
  } catch (error) {
    try {
      logger.error(
        {
          err: error,
          tenantId: input.tenantId,
          eventType: input.eventType,
          sourceType: input.sourceType,
        },
        "Workspace notification publishing failed.",
      );
    } catch {
      // Logging must not turn a best-effort post-commit hook into a rejection.
    }

    return {
      ok: false as const,
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    };
  }
};
