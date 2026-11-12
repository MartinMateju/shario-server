import type {
  ClientSession,
  HydratedDocument,
  InferSchemaType,
} from "mongoose";

import type { WorkspacePermission } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { WorkspaceNotificationPreferences } from "@/modules/tenant-access/tenant-access.types.js";

import type { workspaceNotificationSchema } from "./workspace-notification.schema.js";
import type {
  WorkspaceNotificationCategory,
  WorkspaceNotificationEvent,
  WorkspaceNotificationPreferenceKey,
  WorkspaceNotificationSeverity,
  WorkspaceNotificationStatus,
} from "./workspace-notification.constants.js";

export type WorkspaceNotification = InferSchemaType<
  typeof workspaceNotificationSchema
>;
export type WorkspaceNotificationDocument =
  HydratedDocument<WorkspaceNotification>;

export type WorkspaceNotificationLocalizedText = {
  cs: string;
  en: string;
};

export type WorkspaceNotificationVisibility = {
  tenantId: string;
  recipientUserId: string;
  /** `null` means all locations; an empty array means global records only. */
  allowedLocationIds: readonly string[] | null;
  permissions: readonly WorkspacePermission[];
};

export type WorkspaceNotificationListFilters =
  WorkspaceNotificationVisibility & {
    category?: WorkspaceNotificationCategory;
    locationId?: string;
    status: WorkspaceNotificationStatus;
    page: number;
    limit: number;
  };

export type WorkspaceNotificationReadAllFilters =
  WorkspaceNotificationVisibility & {
    category?: WorkspaceNotificationCategory;
    locationId?: string;
  };

export type PublishWorkspaceNotificationInput = {
  tenantId: string;
  eventType: WorkspaceNotificationEvent;
  /** Derived from eventType when omitted; an explicit value must match it. */
  category?: WorkspaceNotificationCategory;
  severity: WorkspaceNotificationSeverity;
  title: WorkspaceNotificationLocalizedText;
  message: WorkspaceNotificationLocalizedText;
  actionUrl?: string;
  sourceType: string;
  sourceId: string;
  deduplicationKey: string;
  groupKey?: string;
  occurredAt?: Date;
  actorUserId?: string | null;
  locationId?: string | null;
  requiredPermission?: WorkspacePermission | null;
  recipientUserIds?: readonly string[];
  excludedUserIds?: readonly string[];
  preferenceKey?: WorkspaceNotificationPreferenceKey | null;
  session?: ClientSession | null;
};

export type WorkspaceNotificationRecipient = {
  userId: string;
  preferences: WorkspaceNotificationPreferences;
};

export type WorkspaceNotificationCreateRecord = {
  tenantId: string;
  recipientUserId: string;
  locationId?: string | null;
  actorUserId?: string | null;
  eventType: WorkspaceNotificationEvent;
  category: WorkspaceNotificationCategory;
  severity: WorkspaceNotificationSeverity;
  title: WorkspaceNotificationLocalizedText;
  message: WorkspaceNotificationLocalizedText;
  actionUrl?: string;
  sourceType: string;
  sourceId: string;
  requiredPermission?: WorkspacePermission | null;
  deduplicationKey: string;
  groupKey?: string;
  occurredAt?: Date;
};

export type WorkspaceNotificationRepositoryOptions = {
  session?: ClientSession | null;
};
