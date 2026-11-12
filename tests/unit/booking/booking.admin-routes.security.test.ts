import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelBooking: vi.fn((_req, res) => res.status(204).end()),
  updateBooking: vi.fn((_req, res) => res.status(204).end()),
  createCourseBookingRecords: vi.fn((_req, res) => res.status(204).end()),
  readBooking: vi.fn((_req, res) => res.status(204).end()),
  editBooking: vi.fn((_req, res) => res.status(204).end()),
  lookupCustomer: vi.fn((_req, res) => res.status(204).end()),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req, _res, next) => next(),
}));

vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireWorkspaceSession: (_req, _res, next) => next(),
}));

vi.mock("@/modules/tenant-access/tenant-access.permissions.js", () => ({
  WORKSPACE_PERMISSION: {
    BOOKINGS_CREATE: "bookings.create",
    BOOKINGS_VIEW: "bookings.view",
    BOOKINGS_UPDATE: "bookings.update",
    BOOKINGS_CANCEL: "bookings.cancel",
    BOOKINGS_REFUND: "bookings.refund",
  },
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireLocationAccess: () => (_req, _res, next) => next(),
  requirePermission: (permission: string) => (req, res, next) => {
    const permissions = new Set(
      String(req.headers["x-test-permissions"] || "")
        .split(",")
        .filter(Boolean),
    );

    if (!permissions.has(permission)) {
      return res.status(403).json({
        code: "MISSING_PERMISSION",
        permission,
      });
    }

    return next();
  },
}));

vi.mock("@/modules/booking/controllers/booking.course.controller.js", () => ({
  createCourseBookingRecords: mocks.createCourseBookingRecords,
}));

vi.mock("@/modules/booking/controllers/booking.read.controller.js", () => ({
  getBookings: mocks.readBooking,
  getBookingsByProductId: mocks.readBooking,
  getBookingsByUserId: mocks.readBooking,
  getBookingsHistory: mocks.readBooking,
  getBookingsWithFilters: mocks.readBooking,
  getUserBookings: mocks.readBooking,
}));

vi.mock("@/modules/booking/controllers/booking.write.controller.js", () => ({
  cancelBooking: mocks.cancelBooking,
  updateBooking: mocks.updateBooking,
}));

vi.mock("@/modules/booking/controllers/booking.editor.controller.js", () => ({
  readBookingEditor: mocks.readBooking,
  writeBookingEditor: mocks.editBooking,
  lookupBookingEditorCustomer: mocks.lookupCustomer,
}));

vi.mock(
  "@/modules/booking/controllers/booking.participant-increase.controller.js",
  () => ({
    participantIncreaseRequiresCheckout: mocks.updateBooking,
  }),
);

import bookingRouter from "@/modules/booking/booking.routes.js";

const app = express();
app.use(express.json());
app.use("/bookings", bookingRouter);

describe("admin booking workflow permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not allow update permission to reach cancellation", async () => {
    const response = await request(app)
      .patch("/bookings/cancel")
      .set("x-test-permissions", "bookings.update")
      .send({
        id: "64b000000000000000000403",
        userId: "64b000000000000000000404",
      })
      .expect(403);

    expect(response.body).toEqual({
      code: "MISSING_PERMISSION",
      permission: "bookings.cancel",
    });
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("requires refund permission as well as cancellation permission", async () => {
    const response = await request(app)
      .patch("/bookings/cancel")
      .set("x-test-permissions", "bookings.cancel")
      .send({
        id: "64b000000000000000000403",
        userId: "64b000000000000000000404",
      })
      .expect(403);

    expect(response.body).toEqual({
      code: "MISSING_PERMISSION",
      permission: "bookings.refund",
    });
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("delegates only fully authorized requests to the dedicated cancellation controller", async () => {
    await request(app)
      .patch("/bookings/cancel")
      .set("x-test-permissions", "bookings.cancel,bookings.refund")
      .send({
        id: "64b000000000000000000403",
        userId: "64b000000000000000000404",
      })
      .expect(204);

    expect(mocks.cancelBooking).toHaveBeenCalledTimes(1);
  });

  it("keeps DELETE non-mutating even for an authorized administrator", async () => {
    const response = await request(app)
      .delete("/bookings")
      .set("x-test-permissions", "bookings.cancel")
      .send({ id: "64b000000000000000000403" })
      .expect(410);

    expect(response.body.code).toBe("BOOKING_DELETE_REQUIRES_CANCELLATION");
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    expect(mocks.updateBooking).not.toHaveBeenCalled();
  });

  it("requires booking view permission to read the dedicated editor", async () => {
    await request(app)
      .get("/bookings/64b000000000000000000403/editor")
      .expect(403);
    await request(app)
      .get("/bookings/64b000000000000000000403/editor")
      .set("x-test-permissions", "bookings.view")
      .expect(204);
    expect(mocks.readBooking).toHaveBeenCalledOnce();
  });

  it("permits attendance edits with update permission without granting refunds", async () => {
    await request(app)
      .put("/bookings/64b000000000000000000403/editor")
      .set("x-test-permissions", "bookings.view")
      .send({})
      .expect(403);
    await request(app)
      .put("/bookings/64b000000000000000000403/editor")
      .set("x-test-permissions", "bookings.update")
      .send({})
      .expect(204);
    expect(mocks.editBooking).toHaveBeenCalledOnce();
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("restricts exact participant customer lookup to booking editors", async () => {
    await request(app)
      .get("/bookings/64b000000000000000000403/editor/customer?identifier=42")
      .set("x-test-permissions", "bookings.view")
      .expect(403);
    await request(app)
      .get("/bookings/64b000000000000000000403/editor/customer?identifier=42")
      .set("x-test-permissions", "bookings.update")
      .expect(204);
    expect(mocks.lookupCustomer).toHaveBeenCalledOnce();
  });
});
