import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "64b64c8f4f1c2a3b4c5d6e70";
const LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e71";
const PIECE_LOCATION_ID = "64b64c8f4f1c2a3b4c5d6e72";

const mocks = vi.hoisted(() => {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.sort = vi.fn(() => query);
  query.lean = vi.fn(() => query);
  query.exec = vi.fn();

  return {
    findLocations: vi.fn(() => query),
    query,
  };
});

vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.findLocations },
  LocationModel: { find: mocks.findLocations },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: vi.fn() },
}));

vi.mock("@/modules/checkout/services/checkout.capacity.service.js", () => ({
  isActiveCapacityBooking: vi.fn(() => true),
  validateOpenStudioAvailabilityOrThrow: vi.fn(),
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: { findOne: vi.fn() },
}));

vi.mock("@/modules/product/product.utils.js", () => ({
  resolveProductOpenStudioBookingModeV2: vi.fn(),
  toProductCatalogDto: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.constants.js", () => ({
  TENANT_MODULE: {
    BOOKINGS: "bookings",
    FIRING: "firing",
    PAYMENTS: "payments",
  },
}));

vi.mock("@/shared/time/time.utils.js", () => ({
  buildUTCBookingRangeFromLocalInputs: vi.fn(),
  parseDateStringInTimezone: vi.fn(),
}));

import {
  listCustomerBookingLocations,
  serializePublicBookingLocation,
} from "@/modules/booking/booking.public.service.js";

const unsafeLocation = {
  _id: LOCATION_ID,
  tenant: TENANT_ID,
  name: "Public Studio",
  slug: "public-studio",
  code: "INTERNAL-CODE",
  isActive: true,
  isPrimary: true,
  address: {
    line1: "1 Main Street",
    city: "Brno",
    country: "CZ",
  },
  contact: { email: "hello@example.com", phone: "+420123" },
  booking: {
    enabled: true,
    timezone: "Europe/Prague",
    globalCapacity: 8,
    slotStepMinutes: 30,
    minBookingMinutes: 60,
    maxBookingMinutes: 360,
    activityCapacities: [{ activity: "pottery-wheel", capacity: 6 }],
    doorCodeMinutesBefore: 15,
    privateSessionBlocksAll: true,
  },
  openingHours: { monday: { isOpen: true } },
  access: {
    publicInstructions: "Use the front entrance.",
    privateInstructions: "SECRET PRIVATE INSTRUCTIONS",
    doorCode: "SECRET-DOOR-CODE",
  },
  notes: "SECRET INTERNAL NOTES",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const pieceLocation = {
  ...unsafeLocation,
  _id: PIECE_LOCATION_ID,
  name: "Piece Studio",
  slug: "piece-studio",
  isPrimary: false,
  booking: {
    ...unsafeLocation.booking,
    enabled: false,
  },
};

describe("customer location serializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.exec.mockResolvedValue([unsafeLocation, pieceLocation]);
  });

  it("returns only an explicit customer-safe location DTO", () => {
    const dto = serializePublicBookingLocation(unsafeLocation);
    const serialized = JSON.stringify(dto);

    expect(dto).toMatchObject({
      id: LOCATION_ID,
      name: "Public Studio",
      booking: {
        enabled: true,
        timeZone: "Europe/Prague",
        globalCapacity: 8,
        activitySelectionMode: "OPTIONAL",
      },
      publicInstructions: "Use the front entrance.",
    });
    expect(dto).not.toHaveProperty("tenant");
    expect(dto).not.toHaveProperty("code");
    expect(dto).not.toHaveProperty("notes");
    expect(dto).not.toHaveProperty("access");
    expect(serialized).not.toContain("SECRET");
  });

  it("returns all active locations with a whitelist projection", async () => {
    const result = await listCustomerBookingLocations({
      _id: TENANT_ID,
    } as any);

    expect(mocks.findLocations).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(result.locations).toEqual([
      expect.objectContaining({
        id: LOCATION_ID,
        booking: expect.objectContaining({ enabled: true }),
      }),
      expect.objectContaining({
        id: PIECE_LOCATION_ID,
        booking: expect.objectContaining({ enabled: false }),
      }),
    ]);

    const projection = mocks.query.select.mock.calls[0]?.[0] as string;
    expect(projection).toContain("access.publicInstructions");
    expect(projection).toContain("booking.activitySelectionMode");
    expect(projection).not.toContain("access.privateInstructions");
    expect(projection).not.toContain("access.doorCode");
    expect(projection).not.toContain("notes");
    expect(projection).not.toContain(" code ");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
