import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMemberships: vi.fn(),
  resolveWorkspaceAccessForUser: vi.fn(),
  hasWorkspacePermission: vi.fn(),
  canAccessWorkspaceLocation: vi.fn(),
  upsertMany: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));
vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveWorkspaceAccessForUser,
  hasWorkspacePermission: mocks.hasWorkspacePermission,
  canAccessWorkspaceLocation: mocks.canAccessWorkspaceLocation,
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { find: mocks.findMemberships },
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.repository.js",
  () => ({
    workspaceNotificationRepository: { upsertMany: mocks.upsertMany },
  }),
);

import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { TENANT_MEMBERSHIP_STATUS } from "@/modules/tenant-access/tenant-access.constants.js";
import {
  WORKSPACE_NOTIFICATION_CATEGORY,
  WORKSPACE_NOTIFICATION_EVENT,
  WORKSPACE_NOTIFICATION_SEVERITY,
} from "@/modules/workspace-notifications/workspace-notification.constants.js";
import {
  publishWorkspaceNotification,
  publishWorkspaceNotificationSafely,
  toWorkspaceNotificationDailyGroupKey,
} from "@/modules/workspace-notifications/services/workspace-notification-publisher.service.js";
import type { PublishWorkspaceNotificationInput } from "@/modules/workspace-notifications/workspace-notification.types.js";

const id = () => new mongoose.Types.ObjectId().toString();

const notificationInput = (
  overrides: Partial<PublishWorkspaceNotificationInput> = {},
): PublishWorkspaceNotificationInput => ({
  tenantId: id(),
  eventType: WORKSPACE_NOTIFICATION_EVENT.BOOKING_CREATED,
  severity: WORKSPACE_NOTIFICATION_SEVERITY.INFO,
  title: { cs: " Nová rezervace ", en: " New booking " },
  message: { cs: " Rezervace vznikla. ", en: " A booking was created. " },
  actionUrl: "/app/bookings/booking-1",
  sourceType: "booking",
  // Deliberately not an ObjectId: external and migration sources are valid.
  sourceId: "evt_live_booking_1",
  deduplicationKey: "booking.created:booking-1:v1",
  groupKey: "bookings:2026-08-12",
  ...overrides,
});

const queryReturning = (memberships: Array<{ user: string }>) => {
  const query = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(memberships),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  mocks.findMemberships.mockReturnValue(query);
  return query;
};

const access = ({
  permissions = [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
  locationIds = [] as string[],
  inApp = true,
  bookingAssigned = true,
} = {}) => ({
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  permissions,
  locationAccess: { mode: "selected", locationIds },
  preferences: {
    notifications: {
      bookingAssigned,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp,
    },
  },
});

describe("workspace notification publisher", () => {
  it("buckets group keys by UTC day without double-bucketing explicit keys", () => {
    const occurredAt = new Date("2026-08-12T23:55:00.000Z");

    expect(
      toWorkspaceNotificationDailyGroupKey("booking.created", occurredAt),
    ).toBe("booking.created:2026-08-12");
    expect(
      toWorkspaceNotificationDailyGroupKey(
        "booking.created:2026-08-12",
        occurredAt,
      ),
    ).toBe("booking.created:2026-08-12");
    expect(toWorkspaceNotificationDailyGroupKey(undefined, occurredAt)).toBe(
      "",
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasWorkspacePermission.mockImplementation(
      (resolved: { permissions: string[] }, permission: string) =>
        resolved.permissions.includes(permission),
    );
    mocks.canAccessWorkspaceLocation.mockImplementation(
      (
        resolved: { locationAccess: { locationIds: string[] } },
        locationId: string,
      ) => resolved.locationAccess.locationIds.includes(locationId),
    );
    mocks.upsertMany.mockResolvedValue({ createdCount: 1 });
  });

  it("applies active membership, current permission/location and in-app preferences", async () => {
    const tenantId = id();
    const locationId = id();
    const eligibleId = id();
    const inAppDisabledId = id();
    const bookingDisabledId = id();
    const permissionMissingId = id();
    const locationMissingId = id();
    const recipients = [
      eligibleId,
      inAppDisabledId,
      bookingDisabledId,
      permissionMissingId,
      locationMissingId,
    ];
    const query = queryReturning(recipients.map((user) => ({ user })));
    const accessByUser = new Map([
      [eligibleId, access({ locationIds: [locationId] })],
      [inAppDisabledId, access({ locationIds: [locationId], inApp: false })],
      [
        bookingDisabledId,
        access({ locationIds: [locationId], bookingAssigned: false }),
      ],
      [
        permissionMissingId,
        access({ permissions: [], locationIds: [locationId] }),
      ],
      [locationMissingId, access({ locationIds: [id()] })],
    ]);
    mocks.resolveWorkspaceAccessForUser.mockImplementation(
      ({ userId }: { userId: string }) => accessByUser.get(userId) ?? null,
    );

    const result = await publishWorkspaceNotification(
      notificationInput({
        tenantId,
        locationId,
        requiredPermission: WORKSPACE_PERMISSION.BOOKINGS_VIEW,
      }),
    );

    expect(result).toEqual({
      eligibleRecipientCount: 1,
      createdCount: 1,
      duplicateCount: 0,
    });
    expect(mocks.findMemberships).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      }),
    );
    expect(query.select).toHaveBeenCalledWith("user");
    expect(mocks.upsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId,
          recipientUserId: eligibleId,
          locationId,
          category: WORKSPACE_NOTIFICATION_CATEGORY.BOOKINGS,
          title: { cs: "Nová rezervace", en: "New booking" },
          sourceId: "evt_live_booking_1",
          deduplicationKey: "booking.created:booking-1:v1",
          groupKey: "bookings:2026-08-12",
        }),
      ],
      { session: null },
    );
  });

  it("reports recipient-level deduplication without creating noise", async () => {
    const recipientUserId = id();
    queryReturning([{ user: recipientUserId }]);
    mocks.resolveWorkspaceAccessForUser.mockResolvedValue(access());
    mocks.upsertMany.mockResolvedValue({ createdCount: 0 });

    await expect(
      publishWorkspaceNotification(notificationInput()),
    ).resolves.toEqual({
      eligibleRecipientCount: 1,
      createdCount: 0,
      duplicateCount: 1,
    });
  });

  it("rejects a category that conflicts with the canonical event mapping", async () => {
    await expect(
      publishWorkspaceNotification(
        notificationInput({
          category: WORKSPACE_NOTIFICATION_CATEGORY.PAYMENTS,
        }),
      ),
    ).rejects.toThrow("category must be bookings");
    expect(mocks.findMemberships).not.toHaveBeenCalled();
  });

  it("never rejects post-commit callers when fan-out fails", async () => {
    const recipientUserId = id();
    queryReturning([{ user: recipientUserId }]);
    mocks.resolveWorkspaceAccessForUser.mockResolvedValue(access());
    mocks.upsertMany.mockRejectedValue(new Error("MongoDB unavailable"));
    const input = notificationInput();

    await expect(publishWorkspaceNotificationSafely(input)).resolves.toEqual({
      ok: false,
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: input.tenantId,
        eventType: input.eventType,
      }),
      "Workspace notification publishing failed.",
    );
  });
});
