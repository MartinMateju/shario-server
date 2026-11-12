import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  locationExists: vi.fn(),
  upsertMany: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.findUser },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { exists: mocks.locationExists },
}));
vi.mock(
  "@/modules/customer-notifications/customer-notification.repository.js",
  () => ({
    customerNotificationRepository: { upsertMany: mocks.upsertMany },
  }),
);

import {
  publishCustomerNotification,
  publishCustomerNotificationSafely,
} from "@/modules/customer-notifications/services/customer-notification-publisher.service.js";

const id = () => new mongoose.Types.ObjectId().toString();
const chain = (value: unknown) => {
  const query = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

const input = (overrides: Record<string, unknown> = {}) => ({
  tenantId: id(),
  recipientUserId: id(),
  eventType: "booking.created" as const,
  severity: "success" as const,
  title: { cs: "Potvrzeno", en: "Confirmed" },
  message: { cs: "Rezervace potvrzena.", en: "Booking confirmed." },
  actionUrl: "/portal/bookings",
  sourceType: "booking",
  sourceId: "booking-1",
  deduplicationKey: "booking:order-1:booking-1:confirmed",
  ...overrides,
});

describe("customer notification publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockReturnValue(chain({ _id: id() }));
    mocks.locationExists.mockReturnValue(chain({ _id: id() }));
    mocks.upsertMany.mockResolvedValue({ createdCount: 1 });
  });

  it("requires an active recipient in the same tenant", async () => {
    const notification = input();
    await publishCustomerNotification(notification);

    expect(mocks.findUser).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId(notification.recipientUserId),
      tenant: new mongoose.Types.ObjectId(notification.tenantId),
      isAccessGranted: true,
    });
    expect(mocks.upsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: notification.tenantId,
          recipientUserId: notification.recipientUserId,
          actionUrl: "/portal/bookings",
          category: "bookings",
        }),
      ],
      { session: null },
    );
  });

  it("does not store a location outside the tenant", async () => {
    const locationId = id();
    mocks.locationExists.mockReturnValue(chain(null));

    await expect(
      publishCustomerNotification(input({ locationId })),
    ).resolves.toEqual({
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    });
    expect(mocks.locationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new mongoose.Types.ObjectId(locationId),
      }),
    );
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it("rejects unsafe and category-conflicting producer input", async () => {
    await expect(
      publishCustomerNotification(input({ actionUrl: "/portal/../app" })),
    ).rejects.toThrow("inside /portal");
    await expect(
      publishCustomerNotification(input({ category: "payments" })),
    ).rejects.toThrow("category must be bookings");
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("rejects values that would exceed persisted URL or daily group bounds", async () => {
    await expect(
      publishCustomerNotification(
        input({ actionUrl: `/portal/${"a".repeat(493)}` }),
      ),
    ).rejects.toThrow("must not exceed 500");
    await expect(
      publishCustomerNotification(input({ groupKey: "g".repeat(240) })),
    ).rejects.toThrow("daily group key must not exceed 240");
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("does not publish when the scoped recipient is absent or revoked", async () => {
    mocks.findUser.mockReturnValue(chain(null));
    await expect(publishCustomerNotification(input())).resolves.toEqual({
      eligibleRecipientCount: 0,
      createdCount: 0,
      duplicateCount: 0,
    });
    expect(mocks.locationExists).not.toHaveBeenCalled();
    expect(mocks.upsertMany).not.toHaveBeenCalled();
  });

  it("never rejects a post-commit business operation", async () => {
    mocks.upsertMany.mockRejectedValue(new Error("Mongo unavailable"));
    const notification = input();
    await expect(
      publishCustomerNotificationSafely(notification),
    ).resolves.toMatchObject({ ok: false, createdCount: 0 });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: notification.tenantId,
        recipientUserId: notification.recipientUserId,
      }),
      "Customer notification publishing failed.",
    );
  });

  it("passes one session sequentially to audience checks and persistence", async () => {
    const session = { transaction: true } as never;
    const userQuery = chain({ _id: id() });
    const locationQuery = chain({ _id: id() });
    mocks.findUser.mockReturnValue(userQuery);
    mocks.locationExists.mockReturnValue(locationQuery);
    await publishCustomerNotification(input({ locationId: id(), session }));
    expect(userQuery.session).toHaveBeenCalledWith(session);
    expect(locationQuery.session).toHaveBeenCalledWith(session);
    expect(mocks.upsertMany).toHaveBeenCalledWith(expect.any(Array), {
      session,
    });
  });
});
