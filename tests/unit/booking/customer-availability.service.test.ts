import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  locationFind: vi.fn(),
  bookingExec: vi.fn(),
  locationExec: vi.fn(),
  bookingSelect: vi.fn(),
  locationSelect: vi.fn(),
  productFind: vi.fn(),
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
  },
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    find: mocks.locationFind,
  },
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: {
    findOne: vi.fn(),
    find: mocks.productFind,
  },
}));

import {
  listCustomerBookingAvailability,
  listCustomerBookingLocations,
  serializeCustomerAvailabilityBooking,
} from "@/modules/booking/booking.public.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOCATION_ID = "507f1f77bcf86cd799439012";
const PRODUCT_ID = "507f1f77bcf86cd799439013";
const BOOKING_ID = "507f1f77bcf86cd799439014";
const NOW = new Date("2026-08-04T10:00:00.000Z");

const bookingQuery = (bookings: unknown[]) => {
  const lean = vi.fn(() => ({
    exec: mocks.bookingExec.mockResolvedValue(bookings),
  }));
  const sort = vi.fn(() => ({ lean }));
  mocks.bookingSelect.mockReturnValue({ sort });
  return {
    select: mocks.bookingSelect,
  };
};

const locationQuery = (locations: unknown[]) => {
  const lean = vi.fn(() => ({
    exec: mocks.locationExec.mockResolvedValue(locations),
  }));
  const sort = vi.fn(() => ({ lean }));
  mocks.locationSelect.mockReturnValue({ lean, sort });
  return {
    select: mocks.locationSelect,
  };
};

describe("customer booking occupancy catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.productFind.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      session: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: PRODUCT_ID, maxNumberOfParticipants: 10 }]),
    });
    mocks.locationFind.mockReturnValue(
      locationQuery([{ _id: LOCATION_ID }]),
    );
  });

  it("returns active capacity blockers and class sessions through the exact safe DTO", async () => {
    const active = {
      _id: BOOKING_ID,
      tenant: TENANT_ID,
      createdBy: "507f1f77bcf86cd799439099",
      customer: {
        email: "private@example.test",
        firstname: "Private",
      },
      bookingProduct: PRODUCT_ID,
      location: LOCATION_ID,
      start: new Date("2026-08-05T10:00:00.000Z"),
      end: new Date("2026-08-05T12:00:00.000Z"),
      numberOfGuests: 2,
      author: {
        name: "Private Customer",
        memberNumber: 142,
        customId: "legacy-142",
      },
      bookingMode: "public",
      bookingType: "public",
      plannedActivity: "WORKSTATION",
      tag: "open-studio",
      status: "processed",
      paymentStatus: "CONFIRMED",
      paymentExpiresAt: null,
      internalNotes: "Never expose this",
    };
    const cancelled = {
      ...active,
      _id: "507f1f77bcf86cd799439015",
      status: "cancelled",
    };
    const expired = {
      ...active,
      _id: "507f1f77bcf86cd799439016",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: new Date("2026-08-04T09:00:00.000Z"),
    };
    const activeClass = {
      ...active,
      _id: "507f1f77bcf86cd799439017",
      start: new Date("2026-08-06T10:00:00.000Z"),
      end: new Date("2026-08-06T12:00:00.000Z"),
      numberOfGuests: 8,
      author: {
        name: "Class Organizer",
        memberNumber: 999,
        customId: "staff-999",
      },
      participants: [
        {
          firstname: "Class Customer",
          lastname: "Private",
          memberNumber: 143,
          customId: "legacy-143",
        },
        {
          firstname: "Class Guest",
          lastname: "Private",
          memberNumber: 143,
          customId: "legacy-143",
        },
        { firstname: "Another Customer", customId: "legacy-144" },
      ],
      bookingMode: null,
      bookingType: null,
      plannedActivity: null,
      tag: "class",
      status: "pending",
      paymentStatus: null,
      lecturer: {
        id: "507f1f77bcf86cd799439098",
        email: "lecturer@example.test",
      },
    };
    const cancelledClass = {
      ...activeClass,
      _id: "507f1f77bcf86cd799439018",
      status: "cancelled",
    };
    mocks.bookingFind.mockReturnValue(
      bookingQuery([
        active,
        cancelled,
        expired,
        activeClass,
        cancelledClass,
      ]),
    );

    const result = await listCustomerBookingAvailability({
      tenant: { _id: TENANT_ID } as never,
      now: NOW,
    });

    expect(mocks.locationFind).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      isActive: true,
      "booking.enabled": true,
    });
    expect(mocks.bookingFind).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        location: { $in: [LOCATION_ID] },
        start: {
          $lt: new Date("2026-11-01T22:00:00.000Z"),
        },
        end: { $gt: new Date("2026-08-03T22:00:00.000Z") },
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
      }),
    );
    expect(result).toEqual({
      bookings: [
        {
          _id: BOOKING_ID,
          id: BOOKING_ID,
          bookingProduct: PRODUCT_ID,
          productId: PRODUCT_ID,
          location: LOCATION_ID,
          locationId: LOCATION_ID,
          start: active.start,
          end: active.end,
          numberOfGuests: 2,
          participantCount: 2,
          customerIds: ["142"],
          bookingMode: "public",
          publicCapacityLimit: null,
          bookingType: "public",
          plannedActivity: "WORKSTATION",
          tag: "open-studio",
          status: "processed",
          paymentStatus: "CONFIRMED",
          paymentExpiresAt: null,
        },
        {
          _id: activeClass._id,
          id: activeClass._id,
          bookingProduct: PRODUCT_ID,
          productId: PRODUCT_ID,
          location: LOCATION_ID,
          locationId: LOCATION_ID,
          start: activeClass.start,
          end: activeClass.end,
          numberOfGuests: 8,
          participantCount: 8,
          capacityUsed: 10,
          maxNumberOfParticipants: 10,
          courseCapacityUnavailable: false,
          customerIds: ["143", "legacy-144"],
          bookingMode: null,
          publicCapacityLimit: null,
          bookingType: null,
          plannedActivity: null,
          tag: "class",
          status: "pending",
          paymentStatus: null,
          paymentExpiresAt: null,
        },
      ],
    });

    const serialized = JSON.stringify(result);
    for (const forbiddenField of [
      "tenant",
      "createdBy",
      "customer",
      "email",
      "firstname",
      "internalNotes",
      "lecturer",
      "lastname",
      "author",
      "participants",
    ]) {
      expect(serialized).not.toContain(`"${forbiddenField}":`);
    }
    expect(serialized).not.toContain("Private Customer");
    expect(serialized).not.toContain("Class Organizer");
    expect(serialized).not.toContain("staff-999");
    const selectedFields = String(mocks.bookingSelect.mock.calls[0]?.[0]).split(
      " ",
    );
    expect(selectedFields).toEqual(
      expect.arrayContaining([
        "author.memberNumber",
        "author.customId",
        "participants.memberNumber",
        "participants.customId",
      ]),
    );
    for (const forbiddenSelection of ["author", "participants", "createdBy"]) {
      expect(selectedFields).not.toContain(forbiddenSelection);
    }
  });

  it("exposes an extension hold only as anonymous capacity through the exact customer DTO", () => {
    const start = new Date("2026-08-05T12:00:00.000Z");
    const end = new Date("2026-08-05T12:30:00.000Z");
    const paymentExpiresAt = new Date("2026-08-04T10:35:00.000Z");
    const result = serializeCustomerAvailabilityBooking({
      _id: BOOKING_ID,
      tenant: TENANT_ID,
      bookingProduct: PRODUCT_ID,
      location: LOCATION_ID,
      start,
      end,
      tag: "extension-hold",
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt,
      numberOfGuests: 2,
      bookingMode: "public",
      bookingType: "public",
      publicCapacityLimit: 6,
      plannedActivity: "WORKSTATION",
      author: {
        name: "Private owner",
        memberNumber: 142,
        customId: "legacy-142",
      },
      participants: [],
      createdBy: "507f1f77bcf86cd799439099",
      extensionFor: "507f1f77bcf86cd799439098",
      extensionQuoteVersion: "private-snapshot",
      orders: ["private-order"],
    });
    expect(result).toEqual({
      _id: BOOKING_ID,
      id: BOOKING_ID,
      bookingProduct: PRODUCT_ID,
      productId: PRODUCT_ID,
      location: LOCATION_ID,
      locationId: LOCATION_ID,
      start,
      end,
      numberOfGuests: 2,
      participantCount: 2,
      customerIds: [],
      bookingMode: "public",
      bookingType: "public",
      publicCapacityLimit: 6,
      plannedActivity: "WORKSTATION",
      tag: "open-studio",
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt,
    });
  });

  it("keeps zero attendance for an empty class without listing its staff organizer", () => {
    const result = serializeCustomerAvailabilityBooking({
      _id: BOOKING_ID,
      tag: "class",
      numberOfGuests: 0,
      author: { memberNumber: 999, customId: "staff-999" },
      participants: [],
    });

    expect(result).toMatchObject({
      // Retain the existing occupancy field used by studio blocking logic.
      numberOfGuests: 1,
      participantCount: 0,
      customerIds: [],
    });
  });

  it("hides removed attendees and private roster contact details", () => {
    const result = serializeCustomerAvailabilityBooking({
      _id: BOOKING_ID,
      tag: "open-studio",
      numberOfGuests: 1,
      attendanceManaged: true,
      author: { memberNumber: 999, customId: "removed-purchaser" },
      participants: [
        { memberNumber: 999, attendanceStatus: "removed", order: "paid-order" },
        { memberNumber: 22, attendanceStatus: "active", name: "Private Name", email: "private@example.com", phone: "+420123456789" },
      ],
    });
    expect(result).toMatchObject({ participantCount: 1, customerIds: ["22"] });
    const serialized = JSON.stringify(result);
    for (const privateValue of ["999", "removed-purchaser", "Private Name", "private@example.com", "+420123456789", "paid-order"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(result).not.toHaveProperty("participants");
  });

  it("uses available customer snapshots and never substitutes a booking or creator ID", () => {
    expect(
      serializeCustomerAvailabilityBooking({
        _id: BOOKING_ID,
        createdBy: "507f1f77bcf86cd799439099",
        tag: "open-studio",
        numberOfGuests: 4,
        author: { memberNumber: 12, customId: "legacy-12" },
        participants: [
          { memberNumber: 12, customId: "legacy-12" },
          { memberNumber: -1, customId: " legacy-13 " },
          { customId: "GUEST" },
          { customId: " " },
          { memberNumber: 1.5 },
        ],
      }),
    ).toMatchObject({ participantCount: 4, customerIds: ["12", "legacy-13"] });

    expect(
      serializeCustomerAvailabilityBooking({
        _id: BOOKING_ID,
        createdBy: "507f1f77bcf86cd799439099",
        tag: "workshop",
      }),
    ).toMatchObject({ participantCount: 1, customerIds: [] });
  });

  it("does not identify the staff author of internal studio blocks as a customer", () => {
    expect(
      serializeCustomerAvailabilityBooking({
        tag: "private-studio",
        numberOfGuests: 0,
        author: { memberNumber: 999 },
      }),
    ).toMatchObject({ participantCount: 0, customerIds: [] });
  });

  it("returns the whitelisted booking policy required by the portal", async () => {
    mocks.locationFind.mockReturnValue(
      locationQuery([
        {
          _id: LOCATION_ID,
          name: "Main studio",
          slug: "main",
          isPrimary: true,
          address: {},
          contact: {},
          openingHours: {},
          access: {
            publicInstructions: "Ring the bell",
            doorCode: "SECRET",
            privateInstructions: "Staff only",
          },
          booking: {
            enabled: true,
            timezone: "Europe/Prague",
            globalCapacity: 12,
            slotStepMinutes: 30,
            minBookingMinutes: 60,
            maxBookingMinutes: 240,
            allowPublicOverlap: true,
            maxConcurrentOpenStudioBookings: 4,
            activitySelectionMode: "REQUIRED",
            activityCapacities: [
              { activity: "WORKSTATION", capacity: 6 },
            ],
            doorCodeMinutesBefore: 15,
          },
        },
      ]),
    );

    const result = await listCustomerBookingLocations({
      _id: TENANT_ID,
    } as never);

    expect(result).toMatchObject({
      locations: [
        {
          id: LOCATION_ID,
          name: "Main studio",
          booking: {
            enabled: true,
            timeZone: "Europe/Prague",
            timezone: "Europe/Prague",
            globalCapacity: 12,
            slotStepMinutes: 30,
            minBookingMinutes: 60,
            maxBookingMinutes: 240,
            allowPublicOverlap: true,
            allowPublicSoloOverlap: true,
            maxConcurrentOpenStudioBookings: 4,
            maxPublicOverlaps: 4,
            maxPublicSoloOverlaps: 4,
            activitySelectionMode: "REQUIRED",
            activityCapacities: [
              { activity: "WORKSTATION", capacity: 6 },
            ],
          },
        },
      ],
    });
    const selection = String(
      mocks.locationSelect.mock.calls[0]?.[0] ?? "",
    );
    expect(selection).toContain("booking.enabled");
    expect(selection).toContain("booking.globalCapacity");
    expect(selection).toContain("booking.activitySelectionMode");
    expect(selection).toContain("booking.activityCapacities");
    expect(selection).not.toContain("doorCode");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("privateInstructions");
  });

  it("returns no identifiers from inactive or non-bookable locations", async () => {
    mocks.locationFind.mockReturnValue(locationQuery([]));

    await expect(
      listCustomerBookingAvailability({
        tenant: { _id: TENANT_ID } as never,
        locationId: LOCATION_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ bookings: [] });

    expect(mocks.locationFind).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      isActive: true,
      "booking.enabled": true,
      _id: LOCATION_ID,
    });
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("rejects unbounded customer queries before reading inventory", async () => {
    await expect(
      listCustomerBookingAvailability({
        tenant: { _id: TENANT_ID } as never,
        from: NOW,
        to: new Date("2026-11-03T10:00:01.000Z"),
        now: NOW,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "CUSTOMER_AVAILABILITY_RANGE_INVALID",
    });

    expect(mocks.locationFind).not.toHaveBeenCalled();
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });
});
