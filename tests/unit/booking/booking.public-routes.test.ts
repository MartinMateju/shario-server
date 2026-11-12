import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenant = {
  _id: "507f1f77bcf86cd799439011",
  slug: "studio-olivka",
  modules: {
    payments: true,
    bookings: true,
  },
};

const mocks = vi.hoisted(() => ({
  listPublicBookingLocations: vi.fn(),
  getPublicBookingAvailability: vi.fn(),
  listPublicBookingOccupancy: vi.fn(),
  pass: vi.fn((_req, _res, next) => next()),
}));

vi.mock("@/config/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: mocks.pass,
}));

vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: (req, _res, next) => {
    req.tenant = tenant;
    req.tenantId = tenant._id;
    next();
  },
}));

vi.mock("@/modules/product/routes/product.public.routes.js", () => ({
  requirePublicProductSubscription: mocks.pass,
}));

vi.mock("@/modules/booking/booking.public.service.js", () => ({
  listPublicBookingLocations: mocks.listPublicBookingLocations,
  getPublicBookingAvailability: mocks.getPublicBookingAvailability,
  listPublicBookingOccupancy: mocks.listPublicBookingOccupancy,
}));

import { publicBookingRouter } from "@/modules/booking/booking.public.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const app = express();
app.use(publicBookingRouter);
app.use(errorHandler);

describe("public booking route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPublicBookingLocations.mockResolvedValue({
      locations: [{ id: "507f1f77bcf86cd799439021", name: "Grohova" }],
    });
    mocks.getPublicBookingAvailability.mockResolvedValue({
      location: {
        id: "507f1f77bcf86cd799439021",
        name: "Grohova",
      },
      product: {
        id: "507f1f77bcf86cd799439022",
        name: "Open studio",
      },
      date: "2026-08-03",
      timeZone: "Europe/Prague",
      slots: [
        {
          start: "2026-08-03T08:00:00.000Z",
          end: "2026-08-03T10:00:00.000Z",
          available: true,
          remainingCapacity: 4,
        },
      ],
    });
    mocks.listPublicBookingOccupancy.mockResolvedValue({
      location: {
        id: "507f1f77bcf86cd799439021",
        name: "Grohova",
      },
      from: "2026-08-03",
      to: "2026-08-09",
      timeZone: "Europe/Prague",
      blocks: [
        {
          start: "2026-08-03T08:00:00.000Z",
          end: "2026-08-03T10:00:00.000Z",
          kind: "occupied",
        },
      ],
    });
  });

  it("serves public locations from the published route tenant", async () => {
    const response = await request(app)
      .get("/tenants/studio-olivka/booking/locations")
      .expect(200);

    expect(response.body).toEqual({
      locations: [
        {
          id: "507f1f77bcf86cd799439021",
          name: "Grohova",
        },
      ],
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(mocks.listPublicBookingLocations).toHaveBeenCalledWith(tenant);
  });

  it("accepts only the bounded availability query and ignores no tenant override", async () => {
    const response = await request(app)
      .get("/tenants/studio-olivka/booking/availability")
      .query({
        locationId: "507f1f77bcf86cd799439021",
        productId: "507f1f77bcf86cd799439022",
        date: "2026-08-03",
      })
      .expect(200);

    expect(response.body.slots).toEqual([
      {
        start: "2026-08-03T08:00:00.000Z",
        end: "2026-08-03T10:00:00.000Z",
        available: true,
        remainingCapacity: 4,
      },
    ]);
    expect(mocks.getPublicBookingAvailability).toHaveBeenCalledWith({
      tenant,
      locationId: "507f1f77bcf86cd799439021",
      productId: "507f1f77bcf86cd799439022",
      date: "2026-08-03",
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");

    const rejected = await request(app)
      .get("/tenants/studio-olivka/booking/availability")
      .query({
        locationId: "507f1f77bcf86cd799439021",
        productId: "507f1f77bcf86cd799439022",
        date: "2026-08-03",
        tenantId: "507f1f77bcf86cd799439099",
      })
      .expect(400);

    expect(rejected.body).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mocks.getPublicBookingAvailability).toHaveBeenCalledOnce();
  });

  it("serves a strict anonymous occupancy range from the published tenant", async () => {
    const response = await request(app)
      .get("/tenants/studio-olivka/booking/occupancy")
      .query({
        locationId: "507f1f77bcf86cd799439021",
        from: "2026-08-03",
        to: "2026-08-09",
      })
      .expect(200);

    expect(response.body).toEqual({
      location: {
        id: "507f1f77bcf86cd799439021",
        name: "Grohova",
      },
      from: "2026-08-03",
      to: "2026-08-09",
      timeZone: "Europe/Prague",
      blocks: [
        {
          start: "2026-08-03T08:00:00.000Z",
          end: "2026-08-03T10:00:00.000Z",
          kind: "occupied",
        },
      ],
    });
    expect(mocks.listPublicBookingOccupancy).toHaveBeenCalledWith({
      tenant,
      locationId: "507f1f77bcf86cd799439021",
      from: "2026-08-03",
      to: "2026-08-09",
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");

    await request(app)
      .get("/tenants/studio-olivka/booking/occupancy")
      .query({
        locationId: "507f1f77bcf86cd799439021",
        from: "2026-08-03",
        to: "2026-08-09",
        tenantId: "507f1f77bcf86cd799439099",
      })
      .expect(400);

    expect(mocks.listPublicBookingOccupancy).toHaveBeenCalledOnce();
  });
});
