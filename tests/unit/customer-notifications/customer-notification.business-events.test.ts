import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  publish: vi.fn(),
  publishSafely: vi.fn(),
  loggerError: vi.fn(),
}));

const bookingQuery = (value: unknown[]) => {
  const query = {
    select: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
};

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));
vi.mock(
  "@/modules/customer-notifications/services/customer-notification-publisher.service.js",
  () => ({
    publishCustomerNotification: mocks.publish,
    publishCustomerNotificationSafely: mocks.publishSafely,
  }),
);

import {
  emitCustomerCommerceNotificationsForOrderSafely,
  publishCustomerBookingLifecycleNotificationSafely,
  publishCustomerMembershipNotification,
  publishCustomerRefundNotificationSafely,
  publishCustomerVoucherRedeemedNotificationSafely,
} from "@/modules/customer-notifications/customer-notification.business-events.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ORDER_ID = "507f1f77bcf86cd799439012";
const USER_ID = "507f1f77bcf86cd799439013";
const BOOKING_ID = "507f1f77bcf86cd799439014";
const LOCATION_ID = "507f1f77bcf86cd799439015";

describe("customer notification business-event factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFind.mockReturnValue(bookingQuery([]));
    mocks.publish.mockResolvedValue({ createdCount: 1 });
    mocks.publishSafely.mockResolvedValue({ ok: true, createdCount: 1 });
  });

  it("queries paid booking ids with $in and publishes to the paying customer", async () => {
    mocks.bookingFind.mockReturnValue(
      bookingQuery([{ _id: BOOKING_ID, location: LOCATION_ID }]),
    );
    const paidAt = new Date("2026-08-13T09:00:00.000Z");

    await expect(
      emitCustomerCommerceNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          createdBy: USER_ID,
          paidAt,
          workshopBookings: [BOOKING_ID],
        },
      }),
    ).resolves.toEqual({ candidateCount: 1, createdCount: 1 });

    const filter = mocks.bookingFind.mock.calls[0]?.[0];
    expect(String(filter.tenant)).toBe(TENANT_ID);
    expect(filter._id.$in.map(String)).toEqual([BOOKING_ID]);
    expect(mocks.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        recipientUserId: USER_ID,
        locationId: LOCATION_ID,
        eventType: "booking.created",
        actionUrl: "/portal/bookings",
        sourceId: BOOKING_ID,
        deduplicationKey: `booking:${ORDER_ID}:${BOOKING_ID}:customer-confirmed`,
        occurredAt: paidAt,
      }),
    );
  });

  it("publishes a credit-only order without querying bookings", async () => {
    await expect(
      emitCustomerCommerceNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          createdBy: USER_ID,
          creditPurchase: { amount: 500, currency: "CZK" },
        },
      }),
    ).resolves.toEqual({ candidateCount: 1, createdCount: 1 });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: USER_ID,
        eventType: "credits.purchased",
        actionUrl: "/portal/credits",
        deduplicationKey: `order:${ORDER_ID}:credits-purchased`,
      }),
    );
  });

  it("uses a stable transition key without rendering a future occurrence", async () => {
    const notificationTime = new Date("2026-08-13T10:00:00.000Z");
    const newStart = "2026-08-20T12:00:00.000Z";

    await publishCustomerBookingLifecycleNotificationSafely({
      tenantId: TENANT_ID,
      recipientUserId: USER_ID,
      bookingId: BOOKING_ID,
      event: "rescheduled",
      transitionKey: newStart,
      occurredAt: notificationTime,
    });

    expect(mocks.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "booking.rescheduled",
        deduplicationKey: `booking:${BOOKING_ID}:customer-rescheduled:${newStart}`,
        occurredAt: notificationTime,
      }),
    );
  });

  it("refuses unstable reschedule and refund transitions", async () => {
    await publishCustomerBookingLifecycleNotificationSafely({
      tenantId: TENANT_ID,
      recipientUserId: USER_ID,
      bookingId: BOOKING_ID,
      event: "rescheduled",
      transitionKey: "   ",
    });
    await publishCustomerRefundNotificationSafely({
      tenantId: TENANT_ID,
      recipientUserId: USER_ID,
      bookingId: BOOKING_ID,
      refundAmount: 250,
      refundKey: "   ",
    });

    expect(mocks.publishSafely).not.toHaveBeenCalled();
  });

  it("maps membership payment failure without grouping incompatible events", async () => {
    await publishCustomerMembershipNotification({
      tenantId: TENANT_ID,
      recipientUserId: USER_ID,
      membershipId: ORDER_ID,
      type: "payment_failed",
      deduplicationKey: "membership:invoice-1:payment-failed",
    });

    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "membership.payment_failed",
        severity: "warning",
        actionUrl: "/portal/membership",
      }),
    );
    expect(mocks.publish.mock.calls[0]?.[0]).not.toHaveProperty("groupKey");
  });

  it("maps a redeemed voucher to customer credits with recipient-safe dedupe", async () => {
    await publishCustomerVoucherRedeemedNotificationSafely({
      tenantId: TENANT_ID,
      recipientUserId: USER_ID,
      couponId: ORDER_ID,
      creditsAdded: 500,
      currency: "CZK",
    });

    expect(mocks.publishSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        recipientUserId: USER_ID,
        eventType: "voucher.redeemed",
        actionUrl: "/portal/credits",
        sourceType: "coupon",
        sourceId: ORDER_ID,
        deduplicationKey: `coupon:${ORDER_ID}:customer-redeemed`,
      }),
    );
  });
});
