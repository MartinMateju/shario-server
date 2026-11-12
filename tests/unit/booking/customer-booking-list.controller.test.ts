import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(),
  requireTenantId: vi.fn(),
  listMyBookings: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.requireTenantId,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/booking/booking.customer.service.js", () => ({
  cancelMyBooking: vi.fn(),
  getMyBookingRescheduleAvailability: vi.fn(),
  getMyBooking: vi.fn(),
  listMyBookings: mocks.listMyBookings,
  rescheduleMyBooking: vi.fn(),
}));

vi.mock("@/modules/booking/booking.public.service.js", () => ({
  listCustomerBookingAvailability: vi.fn(),
}));

import { listCustomerBookings } from "@/modules/booking/booking.customer.controller.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const CUSTOMER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";
const EMPTY_RESULT = {
  bookings: [],
  totalCount: 0,
  currentPage: 1,
  pageSize: 20,
  totalPages: 0,
};

const app = express();
app.get("/bookings/mine", listCustomerBookings);
app.use(errorHandler);

describe("customer booking list controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserId.mockReturnValue(CUSTOMER_ID);
    mocks.requireTenantId.mockReturnValue(TENANT_ID);
    mocks.listMyBookings.mockResolvedValue(EMPTY_RESULT);
  });

  it("validates and forwards the optional selected location", async () => {
    await request(app)
      .get(
        `/bookings/mine?scope=history&page=2&limit=5&locationId=${LOCATION_ID}`,
      )
      .expect("Cache-Control", "private, no-store, max-age=0")
      .expect(200, EMPTY_RESULT);

    expect(mocks.listMyBookings).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: CUSTOMER_ID,
      scope: "history",
      page: 2,
      limit: 5,
      locationId: LOCATION_ID,
    });
  });

  it("keeps the existing tenant-wide default when location is omitted", async () => {
    await request(app).get("/bookings/mine").expect(200, EMPTY_RESULT);

    expect(mocks.listMyBookings).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: CUSTOMER_ID,
      scope: "upcoming",
      page: 1,
      limit: 20,
    });
  });

  it("rejects an invalid location before querying booking data", async () => {
    const response = await request(app)
      .get("/bookings/mine?locationId=not-an-object-id")
      .expect(400);

    expect(response.body).toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(mocks.listMyBookings).not.toHaveBeenCalled();
  });
});
