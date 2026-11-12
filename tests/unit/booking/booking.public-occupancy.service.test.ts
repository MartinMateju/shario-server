import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  locationFindOne: vi.fn(),
  productExists: vi.fn(),
  bookingSelect: vi.fn(),
  bookingSort: vi.fn(),
  bookingExec: vi.fn(),
  locationSelect: vi.fn(),
  locationExec: vi.fn(),
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
  },
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    find: vi.fn(),
    findOne: mocks.locationFindOne,
  },
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    exists: mocks.productExists,
    findOne: vi.fn(),
  },
}));

import { listPublicBookingOccupancy } from "@/modules/booking/booking.public.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOCATION_ID = "507f1f77bcf86cd799439021";
const NOW = new Date("2026-03-20T10:00:00.000Z");

const tenant = (modules = { payments: true, bookings: true }) =>
  ({
    _id: TENANT_ID,
    modules,
  }) as never;

const location = {
  _id: LOCATION_ID,
  name: "Studio Olivie",
  slug: "studio-olivie",
  isPrimary: true,
  address: { city: "Brno", country: "CZ" },
  contact: { email: "hello@example.test" },
  booking: {
    enabled: true,
    timezone: "Europe/Prague",
    globalCapacity: 8,
    slotStepMinutes: 30,
    minBookingMinutes: 60,
    maxBookingMinutes: 360,
    allowPublicOverlap: true,
    maxConcurrentOpenStudioBookings: 3,
    activityCapacities: [],
  },
  openingHours: {},
  access: {
    publicInstructions: "Use the front entrance.",
    privateInstructions: "Staff alarm instructions",
    doorCode: "1234",
  },
};

const locationQuery = (value: unknown) => {
  const exec = mocks.locationExec.mockResolvedValue(value);
  const lean = vi.fn(() => ({ exec }));
  mocks.locationSelect.mockReturnValue({ lean });
  return { select: mocks.locationSelect };
};

const bookingQuery = (value: unknown[]) => {
  const exec = mocks.bookingExec.mockResolvedValue(value);
  const lean = vi.fn(() => ({ exec }));
  mocks.bookingSort.mockReturnValue({ lean });
  mocks.bookingSelect.mockReturnValue({ sort: mocks.bookingSort });
  return { select: mocks.bookingSelect };
};

describe("public booking occupancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.productExists.mockResolvedValue({ _id: "bookable" });
    mocks.locationFindOne.mockReturnValue(locationQuery(location));
    mocks.bookingFind.mockReturnValue(bookingQuery([]));
  });

  it("uses DST-safe local boundaries, filters inactive rows and merges only overlapping intervals", async () => {
    const privateFields = {
      _id: "507f1f77bcf86cd799439099",
      customer: { email: "private@example.test" },
      internalNotes: "Never expose this",
      numberOfGuests: 4,
      bookingProduct: "507f1f77bcf86cd799439098",
    };
    const rows = [
      {
        ...privateFields,
        start: new Date("2026-03-28T08:00:00.000Z"),
        end: new Date("2026-03-28T10:00:00.000Z"),
        tag: "open-studio",
        status: "processed",
        paymentStatus: "CONFIRMED",
      },
      {
        ...privateFields,
        start: new Date("2026-03-28T09:00:00.000Z"),
        end: new Date("2026-03-28T11:00:00.000Z"),
        tag: "class",
        status: "pending",
        paymentStatus: null,
      },
      {
        ...privateFields,
        start: new Date("2026-03-28T11:00:00.000Z"),
        end: new Date("2026-03-28T12:00:00.000Z"),
        tag: "private-studio",
        status: "processed",
        paymentStatus: "CONFIRMED",
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T08:00:00.000Z"),
        end: new Date("2026-03-29T09:00:00.000Z"),
        tag: "open-studio",
        status: "cancelled",
        paymentStatus: "CONFIRMED",
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T10:00:00.000Z"),
        end: new Date("2026-03-29T11:00:00.000Z"),
        tag: "open-studio",
        status: "pending",
        paymentStatus: "PENDING_PAYMENT",
        paymentExpiresAt: new Date("2026-03-20T09:00:00.000Z"),
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T12:00:00.000Z"),
        end: new Date("2026-03-29T13:00:00.000Z"),
        tag: "class",
        status: "pending",
        paymentStatus: "EXPIRED",
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T13:00:00.000Z"),
        end: new Date("2026-03-29T14:00:00.000Z"),
        tag: "class",
        status: "canceled",
        paymentStatus: "CONFIRMED",
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T14:00:00.000Z"),
        end: new Date("2026-03-29T15:00:00.000Z"),
        tag: "class",
        status: "pending",
        paymentStatus: "PENDING_PAYMENT",
        paymentExpiresAt: new Date("2026-03-20T11:00:00.000Z"),
      },
      {
        ...privateFields,
        start: new Date("2026-03-29T16:00:00.000Z"),
        end: new Date("2026-03-29T17:00:00.000Z"),
        tag: "class",
        status: "pending",
        paymentStatus: "REFUNDED",
      },
    ];
    mocks.bookingFind.mockReturnValue(bookingQuery(rows));

    const result = await listPublicBookingOccupancy({
      tenant: tenant(),
      locationId: LOCATION_ID,
      from: "2026-03-28",
      to: "2026-03-29",
      now: NOW,
    });

    expect(mocks.locationFindOne).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
      isActive: true,
      "booking.enabled": true,
    });
    expect(mocks.productExists).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      isActive: true,
      maxNumberOfParticipants: { $ne: null },
      type: {
        $in: ["workshop", "service", "public-workshop"],
      },
    });
    expect(mocks.bookingFind).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      location: LOCATION_ID,
      start: { $lt: new Date("2026-03-29T22:00:00.000Z") },
      end: { $gt: new Date("2026-03-27T23:00:00.000Z") },
      tag: {
        $in: [
          "extension-hold",
          "open-studio",
          "workshop",
          "class",
          "course",
          "private-studio",
          "private-session",
        ],
      },
    });
    expect(mocks.bookingSelect).toHaveBeenCalledWith(
      "start end tag status archive paymentStatus paymentExpiresAt -_id",
    );
    expect(result).toEqual({
      location: expect.objectContaining({
        id: LOCATION_ID,
        name: "Studio Olivie",
        slug: "studio-olivie",
      }),
      from: "2026-03-28",
      to: "2026-03-29",
      timeZone: "Europe/Prague",
      blocks: [
        {
          start: new Date("2026-03-28T08:00:00.000Z"),
          end: new Date("2026-03-28T11:00:00.000Z"),
          kind: "occupied",
        },
        {
          start: new Date("2026-03-28T11:00:00.000Z"),
          end: new Date("2026-03-28T12:00:00.000Z"),
          kind: "occupied",
        },
        {
          start: new Date("2026-03-29T14:00:00.000Z"),
          end: new Date("2026-03-29T15:00:00.000Z"),
          kind: "occupied",
        },
      ],
    });

    const serialized = JSON.stringify(result);
    for (const forbiddenValue of [
      "private@example.test",
      "Never expose this",
      "507f1f77bcf86cd799439099",
      "507f1f77bcf86cd799439098",
      "numberOfGuests",
      "paymentStatus",
      "doorCode",
      "1234",
      "privateInstructions",
    ]) {
      expect(serialized).not.toContain(forbiddenValue);
    }
    expect(Object.keys(result.blocks[0] ?? {}).sort()).toEqual([
      "end",
      "kind",
      "start",
    ]);
  });

  it("shows only an unexpired extension hold as an anonymous public occupancy interval", async () => {
    const hold = {
      _id: "private-hold",
      extensionFor: "private-booking",
      orders: ["private-order"],
      author: { email: "private@example.test", memberNumber: 142 },
      start: new Date("2026-03-28T12:00:00.000Z"),
      end: new Date("2026-03-28T12:30:00.000Z"),
      tag: "extension-hold",
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: new Date(NOW.getTime() + 35 * 60_000),
    };
    mocks.bookingFind.mockReturnValue(
      bookingQuery([
        hold,
        {
          ...hold,
          start: new Date("2026-03-28T13:00:00.000Z"),
          end: new Date("2026-03-28T13:30:00.000Z"),
          paymentExpiresAt: new Date(NOW.getTime() - 1),
        },
        {
          ...hold,
          start: new Date("2026-03-28T14:00:00.000Z"),
          end: new Date("2026-03-28T14:30:00.000Z"),
          status: "cancelled",
        },
      ]),
    );
    const result = await listPublicBookingOccupancy({
      tenant: tenant(),
      locationId: LOCATION_ID,
      from: "2026-03-28",
      to: "2026-03-29",
      now: NOW,
    });
    expect(result.blocks).toEqual([
      { start: hold.start, end: hold.end, kind: "occupied" },
    ]);
    expect(mocks.bookingSelect).toHaveBeenCalledWith(
      "start end tag status archive paymentStatus paymentExpiresAt -_id",
    );
  });

  it("rejects disabled modules before reading location or booking data", async () => {
    await expect(
      listPublicBookingOccupancy({
        tenant: tenant({ payments: false, bookings: true }),
        locationId: LOCATION_ID,
        from: "2026-03-28",
        to: "2026-03-29",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_MODULE_REQUIRED",
    });

    expect(mocks.locationFindOne).not.toHaveBeenCalled();
    expect(mocks.productExists).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("falls back to the safe studio timezone when stored configuration is invalid", async () => {
    mocks.locationFindOne.mockReturnValue(
      locationQuery({
        ...location,
        booking: { ...location.booking, timezone: "Not/A_Real_Zone" },
      }),
    );

    const result = await listPublicBookingOccupancy({
      tenant: tenant(),
      locationId: LOCATION_ID,
      from: "2026-03-28",
      to: "2026-03-29",
      now: NOW,
    });

    expect(result.timeZone).toBe("Europe/Prague");
    expect(result.location.booking.timeZone).toBe("Europe/Prague");
  });

  it("fails closed before location or occupancy reads when no qualifying public product exists", async () => {
    mocks.productExists.mockResolvedValue(null);

    await expect(
      listPublicBookingOccupancy({
        tenant: tenant(),
        locationId: LOCATION_ID,
        from: "2026-03-28",
        to: "2026-03-29",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_BOOKING_UNAVAILABLE",
    });

    expect(mocks.locationFindOne).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("does not reveal whether a location exists outside the public tenant scope", async () => {
    mocks.locationFindOne.mockReturnValue(locationQuery(null));

    await expect(
      listPublicBookingOccupancy({
        tenant: tenant(),
        locationId: LOCATION_ID,
        from: "2026-03-28",
        to: "2026-03-29",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_LOCATION_NOT_FOUND",
    });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("defends the service boundary against ranges longer than fourteen days", async () => {
    await expect(
      listPublicBookingOccupancy({
        tenant: tenant(),
        locationId: LOCATION_ID,
        from: "2026-03-01",
        to: "2026-03-15",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLIC_BOOKING_OCCUPANCY_RANGE_INVALID",
    });

    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });
});
