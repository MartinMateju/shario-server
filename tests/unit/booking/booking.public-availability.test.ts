import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locationFindOne: vi.fn(),
  productFindOne: vi.fn(),
  bookingFind: vi.fn(),
}));

const locationQuery = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

const productQuery = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const bookingQuery = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    findOne: mocks.locationFindOne,
  },
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    findOne: mocks.productFindOne,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
  },
}));

import { getPublicBookingAvailability } from "@/modules/booking/booking.public.service.js";
import { publicBookingAvailabilityQuerySchema } from "@/modules/booking/booking.public.validators.js";

describe("public booking availability DTO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locationFindOne.mockReturnValue(
      locationQuery({
        _id: "507f1f77bcf86cd799439021",
        tenant: "507f1f77bcf86cd799439011",
        name: "Studio Olivka",
        slug: "olivka",
        isPrimary: true,
        isActive: true,
        address: { city: "Brno", country: "CZ" },
        contact: { email: "hello@example.test" },
        booking: {
          enabled: true,
          timezone: "UTC",
          slotStepMinutes: 60,
          minBookingMinutes: 60,
          maxBookingMinutes: 180,
          globalCapacity: 4,
          allowPublicSoloOverlap: true,
          maxPublicSoloOverlaps: 1,
          privateSessionBlocksAll: true,
          activityCapacities: [],
        },
        openingHours: {
          monday: {
            isOpen: true,
            openTime: "08:00",
            closeTime: "10:00",
          },
        },
        access: {
          publicInstructions: "Ring the bell.",
          privateInstructions: "Disable the alarm.",
          doorCode: "1234",
        },
        notes: "Staff-only location note",
      }),
    );
    mocks.productFindOne.mockReturnValue(
      productQuery({
        _id: "507f1f77bcf86cd799439022",
        tenant: "507f1f77bcf86cd799439011",
        name: "Open studio",
        description: "A wheel and table",
        type: "workshop",
        location: "507f1f77bcf86cd799439021",
        kind: "open-studio",
        bookingMode: "public",
        price: 450,
        extraCharge: 0,
        maxNumberOfParticipants: 3,
        currency: "CZK",
        imageSrc: "",
        isActive: true,
        internalCost: 200,
        supplierNote: "Private product note",
      }),
    );
    mocks.bookingFind.mockReturnValue(
      bookingQuery([
        {
          _id: "507f1f77bcf86cd799439023",
          location: "507f1f77bcf86cd799439021",
          start: new Date("2026-08-03T08:00:00.000Z"),
          end: new Date("2026-08-03T09:00:00.000Z"),
          numberOfGuests: 1,
          bookingMode: "public",
          bookingType: "public",
          plannedActivity: "UNDEFINED",
          tag: "workshop",
          status: "processed",
          paymentStatus: "CONFIRMED",
          author: {
            name: "Private Customer",
            customId: "U-PRIVATE",
          },
          participants: [{ email: "private@example.test" }],
          orders: ["private-order-id"],
          note: "Private booking note",
        },
      ]),
    );
  });

  it("returns aggregate slot availability without customer, order, or access data", async () => {
    const result = await getPublicBookingAvailability({
      tenant: {
        _id: "507f1f77bcf86cd799439011",
        modules: {
          payments: true,
          bookings: true,
          firing: false,
        },
      } as any,
      locationId: "507f1f77bcf86cd799439021",
      productId: "507f1f77bcf86cd799439022",
      date: "2026-08-03",
      now: new Date("2026-07-29T08:00:00.000Z"),
    });
    const serialized = JSON.stringify(result);

    expect(result.slots).toEqual([
      {
        start: new Date("2026-08-03T08:00:00.000Z"),
        end: new Date("2026-08-03T09:00:00.000Z"),
        available: false,
        remainingCapacity: 0,
        remainingBookings: 0,
      },
      {
        start: new Date("2026-08-03T09:00:00.000Z"),
        end: new Date("2026-08-03T10:00:00.000Z"),
        available: true,
        remainingCapacity: 3,
        remainingBookings: 1,
      },
    ]);
    expect(Object.keys(result.slots[0] ?? {}).sort()).toEqual([
      "available",
      "end",
      "remainingBookings",
      "remainingCapacity",
      "start",
    ]);
    expect(serialized).not.toContain("Private Customer");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("private-order-id");
    expect(serialized).not.toContain("Private booking note");
    expect(serialized).not.toContain("Disable the alarm");
    expect(serialized).not.toContain("1234");
    expect(serialized).not.toContain("internalCost");
    expect(serialized).not.toContain("Private product note");
  });

  it.each([
    [
      "2026-11-02",
      "06:00",
      "00:00",
      "2026-11-02T05:00:00.000Z",
      "2026-11-02T23:00:00.000Z",
      18,
    ],
    [
      "2026-11-02",
      "05:00",
      "01:00",
      "2026-11-02T04:00:00.000Z",
      "2026-11-03T00:00:00.000Z",
      20,
    ],
    [
      "2027-03-28",
      "05:00",
      "01:00",
      "2027-03-28T03:00:00.000Z",
      "2027-03-28T23:00:00.000Z",
      20,
    ],
    [
      "2027-10-31",
      "05:00",
      "01:00",
      "2027-10-31T04:00:00.000Z",
      "2027-11-01T00:00:00.000Z",
      20,
    ],
  ])(
    "returns real timezone-aware slots for %s %s–%s",
    async (date, openTime, closeTime, firstStart, lastEnd, count) => {
      const location = await mocks.locationFindOne().exec();
      location.booking.timezone = "Europe/Prague";
      location.openingHours = Object.fromEntries(
        [
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
          "sunday",
        ].map((day) => [day, { isOpen: true, openTime, closeTime }]),
      );
      mocks.bookingFind.mockReturnValue(bookingQuery([]));
      const result = await getPublicBookingAvailability({
        tenant: {
          _id: "507f1f77bcf86cd799439011",
          modules: { bookings: true, payments: true },
        } as any,
        locationId: String(location._id),
        productId: "507f1f77bcf86cd799439022",
        date: String(date),
        now: new Date("2026-10-01T00:00:00Z"),
      });
      expect(result.slots).toHaveLength(Number(count));
      expect(result.slots[0].start.toISOString()).toBe(firstStart);
      expect(result.slots.at(-1)!.end.toISOString()).toBe(lastEnd);
      expect(result.slots.every((slot) => slot.available)).toBe(true);
      expect(mocks.bookingFind).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenant: "507f1f77bcf86cd799439011",
          location: location._id,
          start: { $lt: new Date(String(lastEnd)) },
          end: { $gt: new Date(String(firstStart)) },
        }),
      );
    },
  );

  it("keeps an after-midnight capacity blocker inside the overnight slot query", async () => {
    const location = await mocks.locationFindOne().exec();
    location.booking.timezone = "Europe/Prague";
    location.openingHours.monday = {
      isOpen: true,
      openTime: "05:00",
      closeTime: "01:00",
    };
    mocks.bookingFind.mockReturnValue(
      bookingQuery([
        {
          _id: "507f1f77bcf86cd799439023",
          location: location._id,
          start: new Date("2026-11-02T23:00:00Z"),
          end: new Date("2026-11-03T00:00:00Z"),
          numberOfGuests: 4,
          bookingMode: "private",
          bookingType: "private",
          tag: "open-studio",
          status: "processed",
          paymentStatus: "CONFIRMED",
        },
      ]),
    );
    const result = await getPublicBookingAvailability({
      tenant: {
        _id: "507f1f77bcf86cd799439011",
        modules: { bookings: true, payments: true },
      } as any,
      locationId: String(location._id),
      productId: "507f1f77bcf86cd799439022",
      date: "2026-11-02",
      now: new Date("2026-10-01T00:00:00Z"),
    });
    expect(result.slots[0].available).toBe(true);
    expect(result.slots.at(-1)).toMatchObject({
      start: new Date("2026-11-02T23:00:00Z"),
      available: false,
    });
  });

  it("returns activity-aware remaining capacity when an activity is selected", async () => {
    mocks.locationFindOne.mockReturnValue(
      locationQuery({
        _id: "507f1f77bcf86cd799439021",
        name: "Studio Olivka",
        slug: "olivka",
        isPrimary: true,
        isActive: true,
        address: {},
        contact: {},
        booking: {
          enabled: true,
          timezone: "UTC",
          slotStepMinutes: 60,
          minBookingMinutes: 60,
          maxBookingMinutes: 180,
          globalCapacity: 8,
          allowPublicSoloOverlap: true,
          maxPublicSoloOverlaps: 4,
          activitySelectionMode: "REQUIRED",
          activityCapacities: [
            { activity: "WORKSTATION", capacity: 2 },
            { activity: "SHARED_TABLE", capacity: 6 },
          ],
        },
        openingHours: {
          monday: {
            isOpen: true,
            openTime: "08:00",
            closeTime: "10:00",
          },
        },
        access: {},
      }),
    );
    mocks.bookingFind.mockReturnValue(
      bookingQuery([
        {
          location: "507f1f77bcf86cd799439021",
          start: new Date("2026-08-03T08:00:00.000Z"),
          end: new Date("2026-08-03T09:00:00.000Z"),
          numberOfGuests: 1,
          bookingMode: "public",
          bookingType: "public",
          plannedActivity: "WORKSTATION",
          tag: "workshop",
          status: "processed",
          paymentStatus: "CONFIRMED",
        },
      ]),
    );

    const result = await getPublicBookingAvailability({
      tenant: {
        _id: "507f1f77bcf86cd799439011",
        modules: {
          payments: true,
          bookings: true,
          firing: false,
        },
      } as any,
      locationId: "507f1f77bcf86cd799439021",
      productId: "507f1f77bcf86cd799439022",
      date: "2026-08-03",
      plannedActivity: "WORKSTATION",
      now: new Date("2026-07-29T08:00:00.000Z"),
    });

    expect(result.slots).toEqual([
      expect.objectContaining({
        start: new Date("2026-08-03T08:00:00.000Z"),
        available: true,
        remainingCapacity: 1,
      }),
      expect.objectContaining({
        start: new Date("2026-08-03T09:00:00.000Z"),
        available: true,
        remainingCapacity: 2,
      }),
    ]);
  });

  it("resolves public and private choices against their distinct capacities", async () => {
    mocks.productFindOne.mockReturnValue(productQuery({
      _id: "507f1f77bcf86cd799439022", type: "workshop", kind: "open-studio", bookingMode: "customer-choice",
      location: "507f1f77bcf86cd799439021",
      name: "Choice studio", price: 100, currency: "CZK", maxNumberOfParticipants: 1,
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 175 },
    }));
    mocks.bookingFind.mockReturnValue(bookingQuery([]));
    const args = {
      tenant: { _id: "507f1f77bcf86cd799439011", modules: { bookings: true, payments: true } } as any,
      locationId: "507f1f77bcf86cd799439021", productId: "507f1f77bcf86cd799439022", date: "2026-08-03",
      now: new Date("2026-07-29T08:00:00.000Z"),
    };
    const publicSlots = await getPublicBookingAvailability({ ...args, bookingMode: "public", numberOfGuests: 2 });
    expect(publicSlots.slots[0]).toMatchObject({ available: true, remainingCapacity: 2 });
    const oversizedPublic = await getPublicBookingAvailability({ ...args, bookingMode: "public", numberOfGuests: 3 });
    expect(oversizedPublic.slots[0]).toMatchObject({ available: false, remainingCapacity: 0 });
    const privateSlots = await getPublicBookingAvailability({ ...args, bookingMode: "private", numberOfGuests: 4 });
    expect(privateSlots.slots[0]).toMatchObject({ available: true, remainingCapacity: 4 });
    await expect(getPublicBookingAvailability(args)).rejects.toMatchObject({ code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED" });
  });

  it("accepts an optional planned-activity query and rejects unsupported values", () => {
    const baseQuery = {
      locationId: "507f1f77bcf86cd799439021",
      productId: "507f1f77bcf86cd799439022",
      date: "2026-08-03",
    };

    expect(
      publicBookingAvailabilityQuerySchema.parse({
        ...baseQuery,
        plannedActivity: "WORKSTATION",
      }),
    ).toMatchObject({ plannedActivity: "WORKSTATION" });
    expect(
      publicBookingAvailabilityQuerySchema.safeParse(baseQuery).success,
    ).toBe(true);
    expect(
      publicBookingAvailabilityQuerySchema.safeParse({
        ...baseQuery,
        plannedActivity: "GENERAL",
      }).success,
    ).toBe(false);
  });

  it.each([
    [undefined, "PRODUCT_LOCATION_REQUIRED"],
    ["507f1f77bcf86cd799439099", "PRODUCT_LOCATION_MISMATCH"],
  ])("does not expose bookable slots for studio products assigned to %s", async (location, code) => {
    mocks.productFindOne.mockReturnValue(productQuery({
      _id: "507f1f77bcf86cd799439022", type: "workshop", location,
    }));
    await expect(getPublicBookingAvailability({
      tenant: { _id: "507f1f77bcf86cd799439011", modules: { bookings: true, payments: true } } as any,
      locationId: "507f1f77bcf86cd799439021", productId: "507f1f77bcf86cd799439022", date: "2026-08-03",
    })).rejects.toMatchObject({ code });
    expect(mocks.productFindOne).toHaveBeenCalledWith(expect.objectContaining({
      tenant: "507f1f77bcf86cd799439011",
    }));
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });
});
