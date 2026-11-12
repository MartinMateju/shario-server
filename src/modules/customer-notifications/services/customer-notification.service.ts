import { notFound } from "@/shared/http/httpErrors.js";

import {
  CUSTOMER_NOTIFICATION_CATEGORIES,
  type CustomerNotificationCategory,
} from "../customer-notification.constants.js";
import { customerNotificationRepository } from "../customer-notification.repository.js";
import type {
  CustomerNotificationListFilters,
  CustomerNotificationReadAllFilters,
  CustomerNotificationVisibility,
} from "../customer-notification.types.js";

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
    eventType: String(notification.eventType ?? ""),
    category: String(notification.category ?? ""),
    severity: String(notification.severity ?? ""),
    title: {
      cs: String(notification.title?.cs ?? ""),
      en: String(notification.title?.en ?? ""),
    },
    message: {
      cs: String(notification.message?.cs ?? ""),
      en: String(notification.message?.en ?? ""),
    },
    actionUrl: String(notification.actionUrl ?? ""),
    locationId,
    location: locationId
      ? {
          id: locationId,
          name: String(populatedLocation?.name ?? ""),
          slug: String(populatedLocation?.slug ?? ""),
        }
      : null,
    groupKey: String(notification.groupKey ?? ""),
    occurrenceCount: Math.max(1, Number(notification.occurrenceCount) || 1),
    occurredAt: notification.occurredAt,
    readAt: notification.readAt ?? null,
    isRead: Boolean(notification.readAt),
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
};

const emptyCategoryCounts = (): Record<CustomerNotificationCategory, number> =>
  Object.fromEntries(
    CUSTOMER_NOTIFICATION_CATEGORIES.map((category) => [category, 0]),
  ) as Record<CustomerNotificationCategory, number>;

export const customerNotificationService = {
  async list(filters: CustomerNotificationListFilters) {
    const result = await customerNotificationRepository.list(filters);

    return {
      notifications: result.notifications.map((notification) =>
        serializeNotification(notification as Record<string, any>),
      ),
      pagination: result.pagination,
    };
  },

  async summary(visibility: CustomerNotificationVisibility) {
    const rows = await customerNotificationRepository.summarize(visibility);
    const byCategory = emptyCategoryCounts();

    for (const row of rows) {
      if (row._id in byCategory) {
        byCategory[row._id as CustomerNotificationCategory] = Math.max(
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
    visibility: CustomerNotificationVisibility,
    notificationId: string,
  ) {
    const notification = await customerNotificationRepository.markRead(
      visibility,
      notificationId,
    );

    if (!notification) {
      notFound({
        message: "Customer notification not found.",
        code: "CUSTOMER_NOTIFICATION_NOT_FOUND",
      });
    }

    return serializeNotification(notification as Record<string, any>);
  },

  async markAllRead(filters: CustomerNotificationReadAllFilters) {
    const updatedCount =
      await customerNotificationRepository.markAllRead(filters);
    return { updatedCount };
  },
};
