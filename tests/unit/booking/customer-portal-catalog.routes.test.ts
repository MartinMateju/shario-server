import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availability: vi.fn((_req, res) =>
    res.status(200).json({ bookings: [] }),
  ),
  listBookings: vi.fn((_req, res) =>
    res.status(200).json({ bookings: [] }),
  ),
  customerLocations: vi.fn((_req, res) =>
    res.status(200).json({ locations: [] }),
  ),
  workspaceLocations: vi.fn((_req, res) =>
    res.status(200).json({ locations: ["private"] }),
  ),
  extensionOptions: vi.fn((_req, res) => res.status(200).json({ options: [] })),
  extendBooking: vi.fn((_req, res) => res.status(200).json({ status: "confirmed" })),
  cancelExtension: vi.fn((_req, res) => res.status(200).json({ cancelled: true })),
  pass: vi.fn((_req, _res, next) => next()),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    (
      req as Request & {
        userInfo: Record<string, unknown>;
      }
    ).userInfo = {
      id: "507f1f77bcf86cd799439012",
      tenant: "507f1f77bcf86cd799439011",
      authContext:
        req.get("x-auth-context") === "workspace"
          ? "workspace"
          : "customer",
    };
    next();
  },
}));

vi.mock(
  "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js",
  () => ({
    requireTenantSubscriptionAccess: mocks.pass,
  }),
);

vi.mock(
  "@/modules/tenant-access/tenant-access.middleware.js",
  () => ({
    requirePermission: vi.fn(() => mocks.pass),
    requireLocationAccess: vi.fn(() => mocks.pass),
  }),
);

vi.mock(
  "@/modules/booking/booking.customer.controller.js",
  () => ({
    getCustomerBookingAvailability: mocks.availability,
    listCustomerBookings: mocks.listBookings,
    getCustomerBooking: mocks.pass,
    getCustomerBookingRescheduleAvailability: mocks.pass,
    cancelCustomerBooking: mocks.pass,
    rescheduleCustomerBooking: mocks.pass,
    getCustomerBookingExtensionOptions: mocks.extensionOptions,
    extendCustomerBooking: mocks.extendBooking,
    cancelCustomerBookingExtensionPayment: mocks.cancelExtension,
  }),
);

vi.mock(
  "@/modules/location/controllers/location.controller.js",
  () => ({
    getCustomerLocations: mocks.customerLocations,
    getLocations: mocks.workspaceLocations,
    getLocationById: mocks.pass,
    bootstrapLocation: mocks.pass,
    createLocation: mocks.pass,
    updateLocation: mocks.pass,
    setPrimaryLocation: mocks.pass,
    deactivateLocation: mocks.pass,
    activateLocation: mocks.pass,
    deleteLocation: mocks.pass,
  }),
);

import {
  customerBookingRouter,
} from "@/modules/booking/booking.customer.routes.js";
import locationRouter from "@/modules/location/routes/location.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const app = express();
app.use("/bookings/mine", customerBookingRouter);
app.use("/locations", locationRouter);
app.use(errorHandler);

describe("customer portal catalog route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves authenticated customer availability at the exact FE path", async () => {
    await request(app)
      .get("/bookings/mine/availability")
      .set("x-auth-context", "customer")
      .expect(200, { bookings: [] });

    expect(mocks.availability).toHaveBeenCalledOnce();

    await request(app)
      .get("/bookings/mine/availability")
      .set("x-auth-context", "workspace")
      .expect(403);
    expect(mocks.availability).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "get",
      "/bookings/mine/507f1f77bcf86cd799439013/extension/options",
      "extensionOptions",
      { options: [] },
    ],
    [
      "post",
      "/bookings/mine/507f1f77bcf86cd799439013/extension",
      "extendBooking",
      { status: "confirmed" },
    ],
    [
      "delete",
      "/bookings/mine/507f1f77bcf86cd799439013/extension/pending",
      "cancelExtension",
      { cancelled: true },
    ],
  ] as const)(
    "keeps %s %s restricted to the authenticated customer context",
    async (method, path, handler, response) => {
      await request(app)
        [method](path)
        .set("x-auth-context", "customer")
        .expect(200, response);
      expect(mocks[handler]).toHaveBeenCalledOnce();
      await request(app)
        [method](path)
        .set("x-auth-context", "workspace")
        .expect(403);
      expect(mocks[handler]).toHaveBeenCalledOnce();
    },
  );

  it("serves only the safe customer location route in customer context", async () => {
    await request(app)
      .get("/locations/customer")
      .set("x-auth-context", "customer")
      .expect(200, { locations: [] });

    await request(app)
      .get("/locations")
      .set("x-auth-context", "customer")
      .expect(403);

    expect(mocks.customerLocations).toHaveBeenCalledOnce();
    expect(mocks.workspaceLocations).not.toHaveBeenCalled();
  });

  it("keeps private location reads in workspace context", async () => {
    await request(app)
      .get("/locations")
      .set("x-auth-context", "workspace")
      .expect(200, { locations: ["private"] });

    await request(app)
      .get("/locations/customer")
      .set("x-auth-context", "workspace")
      .expect(403);
  });
});
