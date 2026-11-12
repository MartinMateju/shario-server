import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  emit: vi.fn(),
  emitCustomerCommerce: vi.fn(),
  loggerError: vi.fn(),
}));

const bookingQuery = ({
  value = [],
  error,
}: {
  value?: unknown[];
  error?: Error;
}) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    lean: vi.fn(),
    exec: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(value),
  };
  chain.select.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));
vi.mock("@/modules/customer-notifications/index.js", () => ({
  emitCustomerCommerceNotificationsForOrderSafely: mocks.emitCustomerCommerce,
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.events.js",
  () => ({ emitWorkspaceNotificationEvent: mocks.emit }),
);

import {
  emitBookingCreatedNotificationsForOrderSafely,
  emitImportTerminalNotification,
  emitPaymentRefundedNotificationSafely,
} from "@/modules/workspace-notifications/workspace-notification.business-events.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ORDER_ID = "507f1f77bcf86cd799439012";
const ACTOR_ID = "507f1f77bcf86cd799439013";
const WORKSHOP_BOOKING_ID = "507f1f77bcf86cd799439014";
const COURSE_BOOKING_ID = "507f1f77bcf86cd799439015";
const GUEST_BOOKING_ID = "507f1f77bcf86cd799439016";
const LOCATION_ONE_ID = "507f1f77bcf86cd799439017";
const LOCATION_TWO_ID = "507f1f77bcf86cd799439018";

describe("workspace notification business-event factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFind.mockReturnValue(bookingQuery({ value: [] }));
    mocks.emit.mockReturnValue(true);
    mocks.emitCustomerCommerce.mockResolvedValue({
      candidateCount: 0,
      createdCount: 0,
    });
  });

  it("builds a recipient-specific completed import event", () => {
    emitImportTerminalNotification({
      tenantId: TENANT_ID,
      sessionId: ORDER_ID,
      recipientUserId: ACTOR_ID,
      entityType: "customers",
      status: "completed",
      summary: { created: 3, updated: 2, skipped: 1, failed: 0 },
    });

    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: [ACTOR_ID],
        requiredPermission: "customers.import",
        eventType: "import.completed",
        severity: "success",
        sourceId: ORDER_ID,
        deduplicationKey: `import:${ORDER_ID}:completed`,
      }),
    );
  });

  it("builds a critical failed import event without leaking an error", () => {
    emitImportTerminalNotification({
      tenantId: TENANT_ID,
      sessionId: ORDER_ID,
      recipientUserId: ACTOR_ID,
      entityType: "products",
      status: "failed",
    });

    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "import.failed",
        requiredPermission: "products.import",
        severity: "critical",
        actionUrl: "/app/settings/migration",
      }),
    );
  });

  it("emits one tenant- and location-scoped event per distinct paid booking", async () => {
    mocks.bookingFind.mockReturnValue(
      bookingQuery({
        value: [
          { _id: WORKSHOP_BOOKING_ID, location: LOCATION_ONE_ID },
          { _id: COURSE_BOOKING_ID, location: LOCATION_TWO_ID },
        ],
      }),
    );
    const paidAt = new Date("2026-08-12T08:00:00.000Z");

    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          createdBy: ACTOR_ID,
          paidAt,
          workshopBookings: [WORKSHOP_BOOKING_ID, WORKSHOP_BOOKING_ID],
          courseBookings: [{ bookingId: COURSE_BOOKING_ID }],
          guestIncreaseBookings: [GUEST_BOOKING_ID],
        } as never,
      }),
    ).resolves.toEqual({ candidateCount: 2, emittedCount: 2 });

    const filter = mocks.bookingFind.mock.calls[0]?.[0];
    expect(String(filter.tenant)).toBe(TENANT_ID);
    expect(filter._id.$in.map(String)).toEqual([
      WORKSHOP_BOOKING_ID,
      COURSE_BOOKING_ID,
    ]);
    expect(mocks.emitCustomerCommerce).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      order: expect.objectContaining({ _id: ORDER_ID }),
    });
    expect(mocks.emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actorUserId: ACTOR_ID,
        requiredPermission: "bookings.view",
        preferenceKey: "bookingAssigned",
        locationId: LOCATION_ONE_ID,
        eventType: "booking.created",
        actionUrl: "/app/bookings",
        sourceType: "booking",
        sourceId: WORKSHOP_BOOKING_ID,
        deduplicationKey: `booking:${ORDER_ID}:${WORKSHOP_BOOKING_ID}:created`,
        groupKey: `booking.created:${LOCATION_ONE_ID}`,
        occurredAt: paidAt,
      }),
    );
    expect(mocks.emit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        locationId: LOCATION_TWO_ID,
        sourceId: COURSE_BOOKING_ID,
        deduplicationKey: `booking:${ORDER_ID}:${COURSE_BOOKING_ID}:created`,
      }),
    );
  });

  it("does not classify guest increases or credit purchases as new bookings", async () => {
    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          guestIncreaseBookings: [GUEST_BOOKING_ID],
        } as never,
      }),
    ).resolves.toEqual({ candidateCount: 0, emittedCount: 0 });

    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          creditPurchase: { amount: 25 },
          workshopBookings: [WORKSHOP_BOOKING_ID],
        },
      }),
    ).resolves.toEqual({ candidateCount: 0, emittedCount: 0 });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("bridges a credit-only order to the customer inbox", async () => {
    const order = {
      _id: ORDER_ID,
      createdBy: ACTOR_ID,
      creditPurchase: { amount: 500, currency: "CZK" },
    } as never;

    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order,
      }),
    ).resolves.toEqual({ candidateCount: 0, emittedCount: 0 });

    expect(mocks.emitCustomerCommerce).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      order,
    });
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("never fails a paid order when the customer bridge rejects", async () => {
    mocks.emitCustomerCommerce.mockRejectedValueOnce(
      new Error("customer inbox unavailable"),
    );

    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          createdBy: ACTOR_ID,
          creditPurchase: { amount: 500 },
        } as never,
      }),
    ).resolves.toEqual({ candidateCount: 0, emittedCount: 0 });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, orderId: ORDER_ID }),
      "Customer commerce notification bridge failed.",
    );
  });

  it("ignores missing booking snapshots and never rejects on lookup failure", async () => {
    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          workshopBookings: [WORKSHOP_BOOKING_ID],
        },
      }),
    ).resolves.toEqual({ candidateCount: 1, emittedCount: 0 });
    expect(mocks.emit).not.toHaveBeenCalled();

    mocks.bookingFind.mockReturnValue(
      bookingQuery({ error: new Error("temporary database outage") }),
    );

    await expect(
      emitBookingCreatedNotificationsForOrderSafely({
        tenantId: TENANT_ID,
        order: {
          _id: ORDER_ID,
          workshopBookings: [WORKSHOP_BOOKING_ID],
        },
      }),
    ).resolves.toEqual({ candidateCount: 1, emittedCount: 0 });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, orderId: ORDER_ID }),
      "Paid booking notification materialization failed.",
    );
  });

  it("builds a location-scoped refunded-payment event after cancellation", () => {
    expect(
      emitPaymentRefundedNotificationSafely({
        tenantId: TENANT_ID,
        bookingId: WORKSHOP_BOOKING_ID,
        actorUserId: ACTOR_ID,
        locationId: LOCATION_ONE_ID,
        refundAmount: 850,
        currency: "CZK",
      }),
    ).toBe(true);

    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredPermission: "payments.view",
        locationId: LOCATION_ONE_ID,
        eventType: "payment.refunded",
        severity: "success",
        actionUrl: "/app/finance/orders",
        sourceId: WORKSHOP_BOOKING_ID,
        deduplicationKey: `booking:${WORKSHOP_BOOKING_ID}:payment-refunded`,
        groupKey: `payment.refunded:${LOCATION_ONE_ID}`,
      }),
    );
  });
});
