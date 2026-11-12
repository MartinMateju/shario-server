import { notFound } from "@/shared/http/httpErrors.js";

import {
  WORKSPACE_NOTIFICATION_CATEGORIES,
  type WorkspaceNotificationCategory,
} from "../workspace-notification.constants.js";
import { workspaceNotificationRepository } from "../workspace-notification.repository.js";
import type {
  WorkspaceNotificationListFilters,
  WorkspaceNotificationReadAllFilters,
  WorkspaceNotificationVisibility,
} from "../workspace-notification.types.js";

const assertRequestedLocationIsVisible = (
  visibility: WorkspaceNotificationVisibility,
  locationId?: string,
): void => {
  if (!locationId || visibility.allowedLocationIds === null) return;

  if (!visibility.allowedLocationIds.includes(locationId)) {
    notFound({
      message: "Location not found.",
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
  }
};

const serializeNotification = (notification: Record<string, any>) => {
  const rawLocation = notification.location;
  const populatedLocation =
    rawLocation && typeof rawLocation === "object" && "_id" in rawLocation
      ? rawLocation
      : null;
  const locationId = populatedLocation
    ? String(populatedLocation._id)
    : rawLocation
      ? String(rawLocation)
      : null;

  return {
    id: String(notification._id),
    eventType: notification.eventType,
    category: notification.category,
    severity: notification.severity,
    title: {
      cs: String(notification.title?.cs ?? ""),
      en: String(notification.title?.en ?? ""),
    },
    message: {
      cs: String(notification.message?.cs ?? ""),
      en: String(notification.message?.en ?? ""),
    },
    actionUrl: String(notification.actionUrl ?? ""),
    source: {
      type: String(notification.sourceType ?? ""),
      id: String(notification.sourceId ?? ""),
    },
    locationId,
    location: locationId
      ? {
          id: locationId,
          name: String(populatedLocation?.name ?? ""),
        }
      : null,
    actorUserId: notification.actor ? String(notification.actor) : null,
    groupKey: String(notification.groupKey ?? ""),
    occurrenceCount: Math.max(1, Number(notification.occurrenceCount) || 1),
    occurredAt: notification.occurredAt,
    readAt: notification.readAt ?? null,
    isRead: Boolean(notification.readAt),
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
};

const emptyCategoryCounts = (): Record<WorkspaceNotificationCategory, number> =>
  Object.fromEntries(
    WORKSPACE_NOTIFICATION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<WorkspaceNotificationCategory, number>;

export const workspaceNotificationService = {
  async list(filters: WorkspaceNotificationListFilters) {
    assertRequestedLocationIsVisible(filters, filters.locationId);
    const result = await workspaceNotificationRepository.list(filters);

    return {
      notifications: result.notifications.map((notification) =>
        serializeNotification(notification as Record<string, any>),
      ),
      pagination: result.pagination,
    };
  },

  async summary(
    visibility: WorkspaceNotificationVisibility,
    locationId?: string,
  ) {
    assertRequestedLocationIsVisible(visibility, locationId);
    const rows = await workspaceNotificationRepository.summarize(
      visibility,
      locationId,
    );
    const byCategory = emptyCategoryCounts();

    for (const row of rows) {
      if (row._id in byCategory) {
        byCategory[row._id as WorkspaceNotificationCategory] = Math.max(
          0,
          Number(row.count) || 0,
        );
      }
    }

    return {
      unreadCount: Object.values(byCategory).reduce(
        (total, count) => total + count,
        0,
      ),
      byCategory,
    };
  },

  async markRead(
    visibility: WorkspaceNotificationVisibility,
    notificationId: string,
  ) {
    const notification = await workspaceNotificationRepository.markRead(
      visibility,
      notificationId,
    );

    if (!notification) {
      notFound({
        message: "Workspace notification not found.",
        code: "WORKSPACE_NOTIFICATION_NOT_FOUND",
      });
    }

    return serializeNotification(notification as Record<string, any>);
  },

  async markAllRead(filters: WorkspaceNotificationReadAllFilters) {
    assertRequestedLocationIsVisible(filters, filters.locationId);
    const updatedCount =
      await workspaceNotificationRepository.markAllRead(filters);

    return { updatedCount };
  },
};
