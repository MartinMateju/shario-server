import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  bookingFind: vi.fn(),
  locationFind: vi.fn(),
  bookingAggregate: vi.fn(),
  bookingPopulate: vi.fn(),
}));

vi.mock("@/modules/product/product.repository.js", () => ({
  createProductRepository: () => ({
    findOne: mocks.findOne,
  }),
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    find: mocks.bookingFind,
    aggregate: mocks.bookingAggregate,
    populate: mocks.bookingPopulate,
  },
}));

import { addNextCourseSessions, listPublicCourseSessions } from "@/modules/product/services/product.public-sessions.service.js";

const query = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  populate: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});

describe("public course session DTO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locationFind.mockReturnValue({ distinct: () => ({ exec: async () => ["507f1f77bcf86cd799439013"] }) });
    mocks.findOne.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      name: "Wheel course",
      description: "Learn the wheel",
      type: "course",
      price: 2400,
      extraCharge: 0,
      maxNumberOfParticipants: 4,
      currency: "CZK",
      imageSrc: "",
      studioFlow: undefined,
      isActive: true,
      internalCost: 900,
      supplierNote: "Private course note",
    });
  });

  it("scopes sessions to the selected active tenant location before limiting dates", async () => {
    mocks.bookingFind.mockReturnValue(query([]));
    const tenantId = "507f1f77bcf86cd799439099";
    const locationId = "507f1f77bcf86cd799439013";
    await listPublicCourseSessions({
      tenantId, locationId, productId: "507f1f77bcf86cd799439011", limit: 1,
    });
    expect(mocks.locationFind).toHaveBeenCalledWith({ tenant: tenantId, isActive: true, _id: locationId });
    expect(mocks.bookingFind).toHaveBeenCalledWith(expect.objectContaining({
      tenant: tenantId,
      location: { $in: [locationId] },
      bookingProduct: "507f1f77bcf86cd799439011",
      archive: { $ne: true },
      status: { $ne: "cancelled" },
    }));
    expect(mocks.findOne).toHaveBeenCalledWith(expect.objectContaining({
      isArchived: { $ne: true }, isActive: true,
    }), { lean: false });
  });

  it("filters publication scope in product lookup and restricts unfiltered session lists to that scope", async () => {
    const scoped = "507f1f77bcf86cd799439013";
    mocks.findOne.mockResolvedValue({ _id: "507f1f77bcf86cd799439011", type: "course", courseContent: { locationIds: [scoped] } });
    mocks.locationFind.mockReturnValue({ distinct: () => ({ exec: async () => [scoped, "507f1f77bcf86cd799439014"] }) });
    mocks.bookingFind.mockReturnValue(query([]));
    await listPublicCourseSessions({ tenantId: "507f1f77bcf86cd799439099", productId: "507f1f77bcf86cd799439011", limit: 100 });
    expect(mocks.bookingFind).toHaveBeenCalledWith(expect.objectContaining({ location: { $in: [scoped] } }));
    mocks.locationFind.mockReturnValue({ distinct: () => ({ exec: async () => [scoped] }) });
    await listPublicCourseSessions({ tenantId: "507f1f77bcf86cd799439099", productId: "507f1f77bcf86cd799439011", locationId: scoped, limit: 100 });
    expect(mocks.findOne).toHaveBeenLastCalledWith(expect.objectContaining({ $or: [{ "courseContent.locationIds.0": { $exists: false } }, { "courseContent.locationIds": scoped }] }), { lean: false });
  });

  it.each(["foreign tenant", "inactive", "missing"])("rejects a %s location without reading bookings", async () => {
    mocks.locationFind.mockReturnValue({ distinct: () => ({ exec: async () => [] }) });
    await expect(listPublicCourseSessions({
      tenantId: "507f1f77bcf86cd799439099",
      locationId: "507f1f77bcf86cd799439088",
      productId: "507f1f77bcf86cd799439011", limit: 50,
    })).rejects.toMatchObject({ statusCode: 404, code: "PUBLIC_COURSE_LOCATION_NOT_FOUND" });
    expect(mocks.bookingFind).not.toHaveBeenCalled();
  });

  it("retains global courses without dates and batches next sessions without changing occupancy", async () => {
    const now = new Date("2026-10-20T08:00:00Z");
    const future = new Date("2026-10-22T08:00:00Z");
    const expired = new Date("2026-10-19T08:00:00Z");
    const tenantId = "507f1f77bcf86cd799439099";
    const locationId = "507f1f77bcf86cd799439013";
    const productIds = ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012", "507f1f77bcf86cd799439014"];
    const products = productIds.map(id => ({
      id, _id: id, name: "Existing course", locationId: null,
      maxNumberOfParticipants: 4,
    })) as any;
    const sessions = productIds.slice(0, 2).map((id, index) => ({
      _id: `${id}-session`, bookingProduct: id, start: future, end: future,
      numberOfGuests: index ? 4 : 1,
      capacityReservations: [
        { quantity: 1, expiresAt: future, order: "private-order" },
        { quantity: 2, expiresAt: expired },
      ],
      waitlistCapacityHolds: [{ expiresAt: future }, { expiresAt: expired }],
      participants: [{ status: "paid", email: "private@example.com" }],
      location: { _id: locationId, name: "Václavská", slug: "vaclavska" },
    }));
    const before = structuredClone(sessions);
    mocks.bookingAggregate.mockReturnValue({ exec: async () => sessions });
    mocks.bookingPopulate.mockImplementation(async value => value);
    const result = await addNextCourseSessions({ tenantId, locationId, products, now });

    expect(mocks.bookingAggregate).toHaveBeenCalledOnce();
    const match = mocks.bookingAggregate.mock.calls[0]![0][0].$match;
    expect(String(match.tenant)).toBe(tenantId);
    expect(match.location.$in.map(String)).toEqual([locationId]);
    expect(match.bookingProduct.$in.map(String)).toEqual(productIds);
    expect(match.archive).toEqual({ $ne: true });
    expect(match.status).toEqual({ $ne: "cancelled" });
    expect(result.map(item => item.id)).toEqual(productIds);
    expect(result[0]?.nextSession).toMatchObject({ capacity: 4, remainingCapacity: 1, available: true });
    expect(result[1]?.nextSession).toMatchObject({ capacity: 4, remainingCapacity: 0, available: false });
    expect(result[2]?.nextSession).toBeNull();
    expect(sessions).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("participants");
  });

  it("returns capacity only and never serializes booking customer/order fields", async () => {
    const now = new Date("2026-07-29T08:00:00.000Z");
    mocks.bookingFind.mockReturnValue(
      query([
        {
          _id: "507f1f77bcf86cd799439012",
          bookingProduct: "507f1f77bcf86cd799439011",
          start: new Date("2026-08-10T16:00:00.000Z"),
          end: new Date("2026-08-10T18:00:00.000Z"),
          language: "en",
          lecturer: "Eva",
          numberOfGuests: 1,
          capacityReservations: [
            {
              quantity: 1,
              expiresAt: new Date("2026-07-29T08:05:00.000Z"),
              order: "private-order-id",
            },
          ],
          author: { name: "Private", customId: "U-PRIVATE" },
          participants: [{ firstname: "Private" }],
          orders: ["private-order-id"],
          createdBy: "private-user-id",
          note: "private note",
          location: {
            _id: "507f1f77bcf86cd799439013",
            name: "Grohova",
            slug: "grohova",
            address: { city: "Brno", country: "CZ" },
            booking: { timezone: "Europe/Prague" },
            access: { doorCode: "1234" },
          },
        },
      ]),
    );

    const result = await listPublicCourseSessions({
      tenantId: "507f1f77bcf86cd799439099",
      productId: "507f1f77bcf86cd799439011",
      limit: 50,
      now,
    });
    const serialized = JSON.stringify(result.sessions[0]);

    expect(result.sessions[0]).toMatchObject({
      capacity: 4,
      remainingCapacity: 2,
      available: true,
      lecturer: "Eva",
    });
    expect(Object.keys(result.sessions[0] ?? {}).sort()).toEqual([
      "available",
      "capacity",
      "end",
      "id",
      "language",
      "lecturer",
      "location",
      "remainingCapacity",
      "start",
      "waitlist",
    ]);
    expect(serialized).not.toContain("confirmedCount");
    expect(serialized).not.toContain("reservedCount");
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("order");
    expect(serialized).not.toContain("createdBy");
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain("1234");
    expect(JSON.stringify(result)).not.toContain("internalCost");
    expect(JSON.stringify(result)).not.toContain("Private course note");
  });
});
