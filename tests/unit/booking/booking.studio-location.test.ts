import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(), findProduct: vi.fn(), findLocation: vi.fn(), insertMany: vi.fn(),
}));
vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: vi.fn(() => ({ findById: mocks.findUser })),
}));
vi.mock("@/modules/product/product.repository.js", () => ({
  createProductRepository: vi.fn(() => ({ findById: mocks.findProduct })),
}));
vi.mock("@/modules/location/location.repository.js", () => ({
  locationRepository: { findByIdForTenant: mocks.findLocation },
}));
vi.mock("@/modules/booking/booking.repository.js", () => ({
  createBookingRepository: vi.fn(() => ({ insertMany: mocks.insertMany })),
}));

import { createCourseBookingRecords } from "@/modules/booking/services/booking.course.service.js";
import { createProductRepository } from "@/modules/product/product.repository.js";

const tenantId = "64b000000000000000000101";
const locationId = "64b000000000000000000102";
const productId = "64b000000000000000000103";
const input = {
  createdBy: "64b000000000000000000104",
  bookingProduct: productId, locationId,
  dates: ["2026-11-02"], startTime: "10:00", endTime: "11:00",
};

describe("Private Studio calendar product location", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ firstname: "Staff", customId: "STAFF" });
    mocks.findLocation.mockResolvedValue({ _id: locationId, isActive: true, booking: { enabled: true, timezone: "UTC" } });
    mocks.insertMany.mockImplementation(async (records) => records.map((record: any) => ({ ...record, _id: productId })));
  });

  it.each(["private-studio", "blocker"])("creates %s only at its assigned location", async (type) => {
    mocks.findProduct.mockResolvedValue({ _id: productId, type, location: locationId });
    await expect(createCourseBookingRecords({ tenantId, input })).resolves.toMatchObject({ count: 1 });
    expect(mocks.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ tag: "private-studio", bookingProduct: expect.anything(), location: expect.anything() }),
    ]);
    expect(String(mocks.insertMany.mock.calls[0][0][0].location)).toBe(locationId);
    expect(createProductRepository).toHaveBeenCalledWith({ tenantId });
    expect(mocks.findLocation).toHaveBeenCalledWith(tenantId, locationId);
  });

  it.each([
    [undefined, "PRODUCT_LOCATION_REQUIRED"],
    ["64b000000000000000000199", "PRODUCT_LOCATION_MISMATCH"],
  ])("rejects new Private Studio blocks for location %s before writing", async (location, code) => {
    mocks.findProduct.mockResolvedValue({ _id: productId, type: "blocker", location });
    await expect(createCourseBookingRecords({ tenantId, input })).rejects.toMatchObject({ code });
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });

  it("does not require a studio-product location for a Class session", async () => {
    mocks.findProduct.mockResolvedValue({ _id: productId, type: "course" });
    await expect(createCourseBookingRecords({ tenantId, input })).resolves.toMatchObject({ count: 1 });
  });

  it("rejects a product absent from the tenant-scoped catalog", async () => {
    mocks.findProduct.mockResolvedValue(null);
    await expect(createCourseBookingRecords({ tenantId, input })).rejects.toThrow("Booking product not found");
    expect(mocks.insertMany).not.toHaveBeenCalled();
  });
});
