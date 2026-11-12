import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  orderFind: vi.fn(),
  bookingFind: vi.fn(),
  bookingFindOne: vi.fn(),
  locationFindOne: vi.fn(),
  locationUpdateOne: vi.fn(),
  validateAvailability: vi.fn(),
  isActiveCapacityBooking: vi.fn(() => true),
  cancelWithRefund: vi.fn(),
  rearmAccessCode: vi.fn(),
  findUsableAccessCodeLocations: vi.fn(),
  hasDeliveredForBooking: vi.fn(),
  hasModificationLockForBooking: vi.fn(),
  sendLifecycleEmail: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.userFindOne,
  },
}));

vi.mock("@/modules/order/order.model.js", () => ({
  default: {
    find: mocks.orderFind,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    findOne: mocks.bookingFindOne,
  },
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    findOne: mocks.locationFindOne,
    updateOne: mocks.locationUpdateOne,
  },
}));

vi.mock("@/modules/checkout/services/checkout.capacity.service.js", () => ({
  validateOpenStudioAvailabilityOrThrow: mocks.validateAvailability,
  validateWorkshopAvailabilityOrThrow: mocks.validateAvailability,
  isActiveCapacityBooking: mocks.isActiveCapacityBooking,
}));

vi.mock("@/modules/booking/services/booking.refund.service.js", () => ({
  cancelBookingWithRefund: mocks.cancelWithRefund,
}));

vi.mock("@/modules/access-codes/access-code.repository.js", () => ({
  createAccessCodeNotificationRepository: vi.fn(() => ({
    rearmForReschedule: mocks.rearmAccessCode,
    hasDeliveredForBooking: mocks.hasDeliveredForBooking,
    hasModificationLockForBooking: mocks.hasModificationLockForBooking,
  })),
  accessCodeRepository: {
    findUsableLocationValidity: mocks.findUsableAccessCodeLocations,
  },
  accessCodeNotificationRepository: {
    findDeliveredBookingIds: vi.fn().mockResolvedValue([]),
    findModificationLockedBookingIds: vi.fn().mockResolvedValue([]),
    hasDeliveredForBooking: mocks.hasDeliveredForBooking,
    hasModificationLockForBooking: mocks.hasModificationLockForBooking,
  },
}));

vi.mock(
  "@/modules/booking/services/booking.customer-notification.service.js",
  () => ({
    recordBookingLifecycleEmailInSession: mocks.sendLifecycleEmail,
    dispatchBookingLifecycleEmailSafely: vi.fn(),
  }),
);

import {
  buildCustomerRescheduleRange,
  getCustomerBookingCapabilities,
  rescheduleMyBooking,
  serializeCustomerBooking,
} from "@/modules/booking/booking.customer.service.js";

const TENANT_ID = "64b000000000000000000301";
const CUSTOMER_ID = "64b000000000000000000302";
const BOOKING_ID = "64b000000000000000000303";
const LOCATION_ID = "64b000000000000000000304";
const PRODUCT_ID = "64b000000000000000000305";
const NOW = new Date("2026-08-01T08:00:00.000Z");

const chain = (value: unknown) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};

  for (const method of [
    "select",
    "populate",
    "sort",
    "skip",
    "limit",
    "lean",
    "session",
  ]) {
    query[method] = vi.fn(() => query);
  }

  query.exec = vi.fn().mockResolvedValue(value);
  return query;
};

const location = {
  _id: LOCATION_ID,
  isActive: true,
  booking: {
    enabled: true,
    timezone: "UTC",
    slotStepMinutes: 30,
    globalCapacity: 4,
    allowPublicSoloOverlap: true,
    maxPublicSoloOverlaps: 4,
    privateSessionBlocksAll: true,
    groupBookingBlocksAll: true,
    activityCapacities: [],
    doorCodeMinutesBefore: 20,
  },
  openingHours: {
    monday: {
      isOpen: true,
      openTime: "08:00",
      closeTime: "18:00",
    },
  },
  access: {
    publicInstructions: "Use the courtyard entrance.",
    privateInstructions: "Disable the alarm.",
    doorCode: "1234",
  },
};

const populatedBooking = {
  _id: BOOKING_ID,
  createdBy: CUSTOMER_ID,
  bookingProduct: {
    _id: PRODUCT_ID,
    name: "Open studio",
    type: "workshop",
    currency: "EUR",
  },
  location,
  start: new Date("2026-08-03T08:00:00.000Z"),
  end: new Date("2026-08-03T10:00:00.000Z"),
  status: "processed",
  paymentStatus: "CONFIRMED",
  numberOfGuests: 2,
  bookingType: "private",
  plannedActivity: "UNDEFINED",
  tag: "workshop",
};

describe("customer booking reschedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.userFindOne.mockReturnValue(
      chain({
        _id: CUSTOMER_ID,
        tenantRole: "customer",
        platformRole: "none",
      }),
    );
    mocks.orderFind.mockReturnValue(chain([]));
    mocks.findUsableAccessCodeLocations.mockResolvedValue(new Map());
    mocks.hasDeliveredForBooking.mockResolvedValue(false);
    mocks.hasModificationLockForBooking.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes matching cancellation/reschedule capabilities and safe arrival data", () => {
    const dto = serializeCustomerBooking(populatedBooking);
    const serialized = JSON.stringify(dto);

    expect(dto).toMatchObject({
      canCancel: true,
      canReschedule: true,
      participantCount: 2,
      location: {
        arrival: {
          publicInstructions: "Use the courtyard entrance.",
          accessCodeDeliveryMinutesBefore: 20,
        },
      },
    });
    expect(serialized).not.toContain("Disable the alarm.");
    expect(serialized).not.toContain("1234");

    expect(
      getCustomerBookingCapabilities(
        {
          ...populatedBooking,
          tag: "course",
        },
        NOW,
      ),
    ).toEqual({
      canCancel: false,
      canReschedule: false,
      canExtend: false,
      hasPendingExtension: false,
    });
  });

  it("keeps the original duration and rejects a move outside opening hours", () => {
    const range = buildCustomerRescheduleRange({
      requestedStart: new Date("2026-08-03T11:00:00.000Z"),
      currentStart: new Date(populatedBooking.start),
      currentEnd: new Date(populatedBooking.end),
      location,
      now: NOW,
    });

    expect(range).toMatchObject({
      start: new Date("2026-08-03T11:00:00.000Z"),
      end: new Date("2026-08-03T13:00:00.000Z"),
      durationMinutes: 120,
    });

    expect(() =>
      buildCustomerRescheduleRange({
        requestedStart: new Date("2026-08-03T17:00:00.000Z"),
        currentStart: new Date(populatedBooking.start),
        currentEnd: new Date(populatedBooking.end),
        location,
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "CUSTOMER_BOOKING_RESCHEDULE_OUTSIDE_HOURS",
      }),
    );

    const offsetOpeningHours = {
      ...location,
      openingHours: {
        monday: {
          isOpen: true,
          openTime: "08:15",
          closeTime: "18:00",
        },
      },
    };

    expect(
      buildCustomerRescheduleRange({
        requestedStart: new Date("2026-08-03T08:45:00.000Z"),
        currentStart: new Date(populatedBooking.start),
        currentEnd: new Date(populatedBooking.end),
        location: offsetOpeningHours,
        now: NOW,
      }).start,
    ).toEqual(new Date("2026-08-03T08:45:00.000Z"));
    expect(() =>
      buildCustomerRescheduleRange({
        requestedStart: new Date("2026-08-03T09:00:00.000Z"),
        currentStart: new Date(populatedBooking.start),
        currentEnd: new Date(populatedBooking.end),
        location: offsetOpeningHours,
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining({
        statusCode: 400,
        code: "CUSTOMER_BOOKING_RESCHEDULE_STEP_INVALID",
      }),
    );
  });

  it("anchors after-midnight slot steps to the previous weekday's opening time", () => {
    const input = {
      currentStart: new Date("2026-08-03T10:00:00Z"),
      currentEnd: new Date("2026-08-03T10:30:00Z"),
      now: NOW,
      location: {
        ...location,
        openingHours: {
          monday: { isOpen: true, openTime: "05:15", closeTime: "01:00" },
          tuesday: { isOpen: false },
        },
      },
    };
    expect(
      buildCustomerRescheduleRange({
        ...input,
        requestedStart: new Date("2026-08-04T00:15:00Z"),
      }),
    ).toMatchObject({
      start: new Date("2026-08-04T00:15:00Z"),
      end: new Date("2026-08-04T00:45:00Z"),
    });
    expect(() =>
      buildCustomerRescheduleRange({
        ...input,
        requestedStart: new Date("2026-08-04T00:00:00Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CUSTOMER_BOOKING_RESCHEDULE_STEP_INVALID",
      }),
    );
  });

  it.each([undefined, "64b000000000000000000399"])("preserves a historical booking's location when its current product location is %s", async (currentProductLocation) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const bookingDocument = {
      ...populatedBooking,
      location: LOCATION_ID,
      bookingProduct: PRODUCT_ID,
      save,
      toObject() {
        return { ...this };
      },
    };
    const session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    mocks.bookingFindOne
      .mockReturnValueOnce(chain(bookingDocument))
      .mockReturnValueOnce(chain({
        ...populatedBooking,
        bookingProduct: { ...populatedBooking.bookingProduct, location: currentProductLocation },
      }));
    mocks.locationUpdateOne.mockReturnValue(chain({ matchedCount: 1 }));
    mocks.locationFindOne.mockReturnValue(chain(location));
    mocks.bookingFind.mockReturnValue(chain([]));

    const result = await rescheduleMyBooking({
      tenantId: TENANT_ID,
      userId: CUSTOMER_ID,
      bookingId: BOOKING_ID,
      start: new Date("2026-08-03T11:00:00.000Z"),
      now: NOW,
    });

    expect(mocks.bookingFindOne).toHaveBeenNthCalledWith(1, {
      _id: BOOKING_ID,
      tenant: TENANT_ID,
      createdBy: CUSTOMER_ID,
    });
    expect(mocks.locationUpdateOne).toHaveBeenCalledWith(
      {
        _id: LOCATION_ID,
        tenant: TENANT_ID,
        isActive: true,
        "booking.enabled": true,
      },
      {
        $inc: {
          "booking.capacityRevision": 1,
        },
      },
      { session },
    );
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $ne: BOOKING_ID },
        tenant: TENANT_ID,
        location: LOCATION_ID,
        start: {
          $lt: new Date("2026-08-03T13:00:00.000Z"),
        },
        end: {
          $gt: new Date("2026-08-03T11:00:00.000Z"),
        },
      }),
    );
    expect(mocks.validateAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        openStudioBookings: [
          expect.objectContaining({
            _id: BOOKING_ID,
            location: LOCATION_ID,
            numberOfGuests: 2,
            bookingMode: "private",
            start: new Date("2026-08-03T11:00:00.000Z"),
            end: new Date("2026-08-03T13:00:00.000Z"),
          }),
        ],
      }),
    );
    expect(save).toHaveBeenCalledWith({ session });
    expect(mocks.rearmAccessCode).toHaveBeenCalledWith({
      bookingId: BOOKING_ID,
      bookingStart: new Date("2026-08-03T11:00:00.000Z"),
    });
    expect(bookingDocument).toMatchObject({
      location: LOCATION_ID,
      bookingProduct: PRODUCT_ID,
      numberOfGuests: 2,
      start: new Date("2026-08-03T11:00:00.000Z"),
      end: new Date("2026-08-03T13:00:00.000Z"),
      wasReminderSent: false,
    });
    expect(result).toMatchObject({
      id: BOOKING_ID,
      canReschedule: true,
    });
    expect(mocks.sendLifecycleEmail).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: CUSTOMER_ID,
      event: "rescheduled",
      bookingId: BOOKING_ID,
      transitionKey: expect.any(String),
    }, expect.anything());
  });
});
