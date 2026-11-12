import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  orderFind: vi.fn(),
  orderFindOne: vi.fn(),
  bookingFind: vi.fn(),
  bookingFindOne: vi.fn(),
  bookingCount: vi.fn(),
  cancelWithRefund: vi.fn(),
  findUsableAccessCodeLocations: vi.fn(),
  findDeliveredBookingIds: vi.fn(),
  findModificationLockedBookingIds: vi.fn(),
  hasDeliveredForBooking: vi.fn(),
  hasModificationLockForBooking: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.userFindOne,
  },
}));

vi.mock("@/modules/order/order.model.js", () => ({
  default: {
    find: mocks.orderFind,
    findOne: mocks.orderFindOne,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    findOne: mocks.bookingFindOne,
    countDocuments: mocks.bookingCount,
  },
}));

vi.mock("@/modules/booking/services/booking.refund.service.js", () => ({
  cancelBookingWithRefund: mocks.cancelWithRefund,
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: {},
}));

vi.mock("@/modules/checkout/services/checkout.capacity.service.js", () => ({
  isActiveCapacityBooking: vi.fn(() => false),
  validateOpenStudioAvailabilityOrThrow: vi.fn(),
}));

vi.mock(
  "@/modules/booking/services/booking.customer-notification.service.js",
  () => ({
    recordBookingLifecycleEmailInSession: vi.fn(),
    dispatchBookingLifecycleEmailSafely: vi.fn(),
  }),
);

vi.mock("@/modules/access-codes/access-code.repository.js", () => ({
  createAccessCodeNotificationRepository: vi.fn(() => ({
    rearmForReschedule: vi.fn(),
    hasDeliveredForBooking: mocks.hasDeliveredForBooking,
    hasModificationLockForBooking: mocks.hasModificationLockForBooking,
  })),
  accessCodeRepository: {
    findUsableLocationValidity: mocks.findUsableAccessCodeLocations,
  },
  accessCodeNotificationRepository: {
    findDeliveredBookingIds: mocks.findDeliveredBookingIds,
    findModificationLockedBookingIds: mocks.findModificationLockedBookingIds,
    hasDeliveredForBooking: mocks.hasDeliveredForBooking,
    hasModificationLockForBooking: mocks.hasModificationLockForBooking,
  },
}));

import {
  getMyBooking,
  listCustomerBookingsForWorkspace,
  listMyBookings,
} from "@/modules/booking/booking.customer.service.js";
import { getMyOrderConfirmation } from "@/modules/order/order.customer.service.js";

const TENANT_A = "64b000000000000000000201";
const TENANT_B = "64b000000000000000000202";
const CUSTOMER_A = "64b000000000000000000203";
const CUSTOMER_B = "64b000000000000000000204";
const BOOKING_ID = "64b000000000000000000205";
const ORDER_ID = "64b000000000000000000206";

const chain = (value: unknown) => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    "select",
    "populate",
    "sort",
    "skip",
    "limit",
    "lean",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.exec = vi.fn().mockResolvedValue(value);
  return query;
};

const customer = {
  _id: CUSTOMER_A,
  tenantRole: "customer",
  platformRole: "none",
};

describe("customer-owned booking APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindOne.mockReturnValue(chain(customer));
    mocks.orderFind.mockReturnValue(chain([]));
    mocks.bookingCount.mockReturnValue(chain(0));
    mocks.findUsableAccessCodeLocations.mockResolvedValue(new Map());
    mocks.findDeliveredBookingIds.mockResolvedValue([]);
    mocks.findModificationLockedBookingIds.mockResolvedValue([]);
    mocks.hasDeliveredForBooking.mockResolvedValue(false);
    mocks.hasModificationLockForBooking.mockResolvedValue(false);
  });

  it("lists only bookings selected by tenant and authenticated owner", async () => {
    const start = new Date(Date.now() + 3_600_000);
    const booking = {
      _id: BOOKING_ID,
      createdBy: CUSTOMER_A,
      tag: "workshop",
      status: "confirmed",
      paymentStatus: "confirmed",
      start,
      end: new Date(start.getTime() + 3_600_000),
      numberOfGuests: 1,
      bookingType: "public",
      plannedActivity: "UNDEFINED",
      bookingProduct: {
        _id: "64b000000000000000000207",
        name: "Open studio",
        type: "workshop",
        currency: "EUR",
      },
      location: {
        _id: "64b000000000000000000208",
        name: "Main room",
        booking: {
          timezone: "Europe/Prague",
        },
      },
      customerEmail: "must-not-leak@example.com",
      internalNotes: "must not leak",
    };
    mocks.bookingFind.mockReturnValue(chain([booking]));
    mocks.bookingCount.mockReturnValue(chain(1));

    const result = await listMyBookings({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      scope: "all",
    });

    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: CUSTOMER_A,
      tenant: TENANT_A,
      isAccessGranted: true,
    });
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_A,
        $or: [
          {
            createdBy: CUSTOMER_A,
            tag: { $in: ["open-studio", "workshop"] },
          },
        ],
      }),
    );
    expect(mocks.bookingFind.mock.calls[0]?.[0]).not.toHaveProperty("location");
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0]).not.toHaveProperty("createdBy");
    expect(result.bookings[0]).not.toHaveProperty("customerEmail");
    expect(result.bookings[0]).not.toHaveProperty("internalNotes");
  });

  it("scopes the paginated booking list and count to the selected location", async () => {
    const locationId = "64b000000000000000000208";
    const bookingQuery = chain([]);
    mocks.bookingFind.mockReturnValue(bookingQuery);
    mocks.bookingCount.mockReturnValue(chain(0));

    await listMyBookings({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      scope: "all",
      page: 2,
      limit: 5,
      locationId,
    });

    const findFilter = mocks.bookingFind.mock.calls[0]?.[0];
    const countFilter = mocks.bookingCount.mock.calls[0]?.[0];

    expect(findFilter).toMatchObject({
      tenant: TENANT_A,
      location: { $in: [locationId] },
      $or: [
        {
          createdBy: CUSTOMER_A,
          tag: { $in: ["open-studio", "workshop"] },
        },
      ],
    });
    expect(countFilter).toEqual(findFilter);
    expect(bookingQuery.skip).toHaveBeenCalledWith(5);
    expect(bookingQuery.limit).toHaveBeenCalledWith(5);
  });

  it("includes cancelled future bookings in customer history", async () => {
    mocks.bookingFind.mockReturnValue(chain([]));
    mocks.bookingCount.mockReturnValue(chain(0));

    await listMyBookings({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      scope: "history",
    });

    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_A,
        $and: [
          {
            $or: expect.arrayContaining([
              {
                end: {
                  $lt: expect.any(Date),
                },
              },
              {
                status: { $in: expect.arrayContaining(["cancelled"]) },
              },
            ]),
          },
        ],
      }),
    );
  });

  it("keeps an in-progress booking in Upcoming until it ends", async () => {
    mocks.bookingFind.mockReturnValue(chain([]));
    mocks.bookingCount.mockReturnValue(chain(0));

    await listMyBookings({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      scope: "upcoming",
    });

    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_A,
        end: {
          $gte: expect.any(Date),
        },
      }),
    );
  });

  it("returns the same not-found response for another customer's booking", async () => {
    mocks.bookingFindOne.mockReturnValue(
      chain({
        _id: BOOKING_ID,
        createdBy: CUSTOMER_B,
        tag: "workshop",
        start: new Date(Date.now() + 60_000),
      }),
    );

    await expect(
      getMyBooking({
        tenantId: TENANT_A,
        userId: CUSTOMER_A,
        bookingId: BOOKING_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CUSTOMER_BOOKING_NOT_FOUND",
    });

    expect(mocks.bookingFindOne).toHaveBeenCalledWith({
      _id: BOOKING_ID,
      tenant: TENANT_A,
    });
  });

  it("allows an owner identity in explicit customer mode while keeping owner scoping", async () => {
    mocks.userFindOne.mockReturnValue(
      chain({
        _id: CUSTOMER_A,
        tenantRole: "owner",
        platformRole: "none",
      }),
    );
    mocks.bookingFind.mockReturnValue(chain([]));

    await expect(
      listMyBookings({
        tenantId: TENANT_A,
        userId: CUSTOMER_A,
      }),
    ).resolves.toMatchObject({ bookings: [] });

    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_A,
        $or: [
          {
            createdBy: CUSTOMER_A,
            tag: { $in: ["open-studio", "workshop"] },
          },
        ],
      }),
    );
  });

  it("rejects a platform identity before querying customer booking data", async () => {
    mocks.userFindOne.mockReturnValue(
      chain({
        _id: CUSTOMER_A,
        tenantRole: "owner",
        platformRole: "admin",
      }),
    );

    await expect(
      listMyBookings({
        tenantId: TENANT_A,
        userId: CUSTOMER_A,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "CUSTOMER_ACCOUNT_REQUIRED",
    });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.orderFind).not.toHaveBeenCalled();
  });

  it("scopes order confirmation by tenant and authenticated owner", async () => {
    mocks.orderFindOne.mockReturnValueOnce(
      chain({
        _id: ORDER_ID,
        tenant: TENANT_A,
        createdBy: CUSTOMER_A,
        status: "processed_order",
        isPaid: true,
        currency: "EUR",
        grossAmountMinor: 4_500,
        expectedAmountMinor: 4_500,
        paidAmountMinor: 4_500,
        paymentAllocations: [],
        lineItems: [],
        workshopBookings: [],
        courseBookings: [],
        createdAt: new Date(),
      }),
    );

    const result = await getMyOrderConfirmation({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      orderId: ORDER_ID,
    });

    expect(mocks.orderFindOne).toHaveBeenCalledWith({
      _id: ORDER_ID,
      tenant: TENANT_A,
      createdBy: CUSTOMER_A,
    });
    expect(result).toMatchObject({
      orderId: ORDER_ID,
      status: "processed_order",
      isPaid: true,
      terminal: true,
    });
    expect(result).not.toHaveProperty("createdBy");

    mocks.orderFindOne.mockReturnValueOnce(chain(null));

    await expect(
      getMyOrderConfirmation({
        tenantId: TENANT_B,
        userId: CUSTOMER_B,
        orderId: ORDER_ID,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CUSTOMER_ORDER_NOT_FOUND",
    });
  });
});

describe("workspace customer booking history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindOne.mockReturnValue(chain(customer));
    mocks.orderFind.mockReturnValue(chain([]));
    mocks.bookingFind.mockReturnValue(chain([]));
    mocks.bookingCount.mockReturnValue(chain(0));
    mocks.findUsableAccessCodeLocations.mockResolvedValue(new Map());
    mocks.findDeliveredBookingIds.mockResolvedValue([]);
    mocks.findModificationLockedBookingIds.mockResolvedValue([]);
  });

  it("combines paid classes with open studio history, applies location scope, and paginates safe DTOs", async () => {
    const locationId = "64b000000000000000000208";
    const courseId = "64b000000000000000000209";
    const start = new Date("2026-07-01T09:00:00.000Z");
    const course = {
      _id: courseId,
      tag: "course",
      status: "processed",
      start,
      end: new Date("2026-07-01T11:00:00.000Z"),
      bookingProduct: {
        _id: "64b000000000000000000210",
        name: "Wheel course",
        kind: "class",
      },
      location: { _id: locationId, name: "Main room" },
      internalNotes: "must not leak",
      customerEmail: "must-not-leak@example.com",
    };

    mocks.orderFind.mockReturnValue(
      chain([
        {
          _id: ORDER_ID,
          courseBookings: [{ bookingId: courseId, quantity: 2 }],
        },
      ]),
    );
    const bookingQuery = chain([course]);
    mocks.bookingFind.mockReturnValue(bookingQuery);
    mocks.bookingCount.mockReturnValue(chain(6));

    const result = await listCustomerBookingsForWorkspace({
      tenantId: TENANT_A,
      userId: CUSTOMER_A,
      scope: "all",
      page: 2,
      limit: 5,
      allowedLocationIds: [locationId],
    });

    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: CUSTOMER_A,
      tenant: TENANT_A,
    });
    expect(mocks.orderFind).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: TENANT_A, createdBy: CUSTOMER_A }),
    );
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_A,
        location: { $in: [locationId] },
        $or: expect.arrayContaining([
          {
            createdBy: CUSTOMER_A,
            tag: { $in: ["open-studio", "workshop"] },
          },
          {
            _id: { $in: [expect.any(Object)] },
            tag: { $in: ["class", "course"] },
          },
        ]),
      }),
    );
    expect(bookingQuery.skip).toHaveBeenCalledWith(5);
    expect(bookingQuery.limit).toHaveBeenCalledWith(5);
    expect(result).toMatchObject({
      totalCount: 6,
      currentPage: 2,
      pageSize: 5,
      totalPages: 2,
    });
    expect(result.bookings[0]).toMatchObject({
      id: courseId,
      type: "course",
      kind: "class",
      participantCount: 2,
    });
    expect(result.bookings[0]).not.toHaveProperty("internalNotes");
    expect(result.bookings[0]).not.toHaveProperty("customerEmail");
  });

  it("returns tenant-scoped not found before reading another tenant's history", async () => {
    mocks.userFindOne.mockReturnValue(chain(null));

    await expect(
      listCustomerBookingsForWorkspace({
        tenantId: TENANT_A,
        userId: CUSTOMER_B,
        scope: "history",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CUSTOMER_ACCOUNT_NOT_FOUND",
    });

    expect(mocks.orderFind).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });
});
