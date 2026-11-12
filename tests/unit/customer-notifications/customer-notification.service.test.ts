import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  list: vi.fn(),
  summarize: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}));

vi.mock(
  "@/modules/customer-notifications/customer-notification.repository.js",
  () => ({ customerNotificationRepository: repositoryMocks }),
);

import { customerNotificationService } from "@/modules/customer-notifications/services/customer-notification.service.js";

const id = () => new mongoose.Types.ObjectId().toString();
const visibility = () => ({ tenantId: id(), recipientUserId: id() });

describe("customer notification service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the complete stable customer category summary", async () => {
    repositoryMocks.summarize.mockResolvedValue([
      { _id: "bookings", count: 2 },
      { _id: "account", count: 1 },
      { _id: "unknown", count: 500 },
    ]);

    await expect(
      customerNotificationService.summary(visibility()),
    ).resolves.toEqual({
      unreadCount: 3,
      byCategory: {
        bookings: 2,
        payments: 0,
        waitlist: 0,
        memberships: 0,
        credits_vouchers: 0,
        account: 1,
      },
    });
  });

  it("serializes a safe DTO without internal audience or source fields", async () => {
    const notificationId = id();
    const locationId = id();
    repositoryMocks.list.mockResolvedValue({
      notifications: [
        {
          _id: notificationId,
          tenant: id(),
          recipient: id(),
          sourceType: "private-source",
          sourceId: "private-id",
          deduplicationKey: "private-key",
          eventType: "booking.created",
          category: "bookings",
          severity: "success",
          title: { cs: "Potvrzeno", en: "Confirmed" },
          message: { cs: "Zpráva", en: "Message" },
          actionUrl: "/portal/bookings",
          location: { _id: locationId, name: "Karlín", slug: "karlin" },
          occurredAt: new Date("2026-08-13T10:00:00.000Z"),
          readAt: null,
          occurrenceCount: 1,
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, pages: 1 },
    });

    const result = await customerNotificationService.list({
      ...visibility(),
      status: "all",
      page: 1,
      limit: 20,
    });
    const notification = result.notifications[0] as Record<string, unknown>;
    expect(notification).toMatchObject({
      id: notificationId,
      location: { id: locationId, name: "Karlín", slug: "karlin" },
      isRead: false,
    });
    expect(notification).not.toHaveProperty("tenant");
    expect(notification).not.toHaveProperty("recipient");
    expect(notification).not.toHaveProperty("source");
    expect(notification).not.toHaveProperty("sourceId");
    expect(notification).not.toHaveProperty("deduplicationKey");
  });

  it("uses an indistinguishable 404 outside the recipient scope", async () => {
    repositoryMocks.markRead.mockResolvedValue(null);
    await expect(
      customerNotificationService.markRead(visibility(), id()),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CUSTOMER_NOTIFICATION_NOT_FOUND",
    });
  });
});
