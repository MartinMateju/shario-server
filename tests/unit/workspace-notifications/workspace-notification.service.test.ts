import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  list: vi.fn(),
  summarize: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));

vi.mock(
  "@/modules/workspace-notifications/workspace-notification.repository.js",
  () => ({ workspaceNotificationRepository: repositoryMocks }),
);

import {
  WORKSPACE_NOTIFICATION_CATEGORY,
  WORKSPACE_NOTIFICATION_STATUS,
} from "@/modules/workspace-notifications/workspace-notification.constants.js";
import { workspaceNotificationService } from "@/modules/workspace-notifications/services/workspace-notification.service.js";

const id = () => new mongoose.Types.ObjectId().toString();

const visibility = (locationIds: readonly string[] | null) => ({
  tenantId: id(),
  recipientUserId: id(),
  allowedLocationIds: locationIds,
  permissions: [] as const,
});

describe("workspace notification service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not reveal an explicitly requested unassigned location", async () => {
    const assignedLocationId = id();
    const unassignedLocationId = id();

    await expect(
      workspaceNotificationService.list({
        ...visibility([assignedLocationId]),
        locationId: unassignedLocationId,
        status: WORKSPACE_NOTIFICATION_STATUS.ALL,
        page: 1,
        limit: 20,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });
    expect(repositoryMocks.list).not.toHaveBeenCalled();
  });

  it("serializes a populated location and page metadata", async () => {
    const locationId = id();
    const notificationId = id();
    repositoryMocks.list.mockResolvedValue({
      notifications: [
        {
          _id: notificationId,
          eventType: "booking.created",
          category: WORKSPACE_NOTIFICATION_CATEGORY.BOOKINGS,
          severity: "info",
          title: { cs: "Nová rezervace", en: "New booking" },
          message: { cs: "Zpráva", en: "Message" },
          actionUrl: "/app/bookings/booking-1",
          sourceType: "booking",
          sourceId: "booking-1",
          location: { _id: locationId, name: "Karlín" },
          actor: null,
          groupKey: "bookings:2026-08-12",
          occurrenceCount: 1,
          occurredAt: new Date("2026-08-12T08:00:00.000Z"),
          readAt: null,
          createdAt: new Date("2026-08-12T08:00:00.000Z"),
          updatedAt: new Date("2026-08-12T08:00:00.000Z"),
        },
      ],
      pagination: { page: 2, limit: 8, total: 9, pages: 2 },
    });

    const result = await workspaceNotificationService.list({
      ...visibility(null),
      status: WORKSPACE_NOTIFICATION_STATUS.ALL,
      page: 2,
      limit: 8,
    });

    expect(result.pagination).toEqual({
      page: 2,
      limit: 8,
      total: 9,
      pages: 2,
    });
    expect(result.notifications[0]).toMatchObject({
      id: notificationId,
      locationId,
      location: { id: locationId, name: "Karlín" },
      isRead: false,
    });
  });

  it("returns a complete stable category summary", async () => {
    repositoryMocks.summarize.mockResolvedValue([
      { _id: WORKSPACE_NOTIFICATION_CATEGORY.BOOKINGS, count: 3 },
      { _id: WORKSPACE_NOTIFICATION_CATEGORY.ACCOUNT, count: 1 },
      { _id: "removed-category", count: 100 },
    ]);

    await expect(
      workspaceNotificationService.summary(visibility(null)),
    ).resolves.toMatchObject({
      unreadCount: 4,
      byCategory: {
        bookings: 3,
        payments: 0,
        waitlist: 0,
        tasks: 0,
        inventory: 0,
        migration: 0,
        communications: 0,
        account: 1,
      },
    });
  });

  it("does not acknowledge a record outside repository visibility", async () => {
    repositoryMocks.markRead.mockResolvedValue(null);

    await expect(
      workspaceNotificationService.markRead(visibility([]), id()),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_NOTIFICATION_NOT_FOUND",
    });
  });
});
