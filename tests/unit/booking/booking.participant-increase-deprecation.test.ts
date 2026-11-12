import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  createCourseBookingRecords: vi.fn(),
  getBookings: vi.fn(),
  getBookingsByProductId: vi.fn(),
  getBookingsByUserId: vi.fn(),
  getBookingsHistory: vi.fn(),
  getBookingsWithFilters: vi.fn(),
  getUserBookings: vi.fn(),
  cancelBooking: vi.fn(),
  deleteBooking: vi.fn(),
  updateBooking: vi.fn(),
  readBookingEditor: vi.fn(),
  writeBookingEditor: vi.fn(),
  lookupBookingEditorCustomer: vi.fn(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req, res, next) => {
    if (!mocks.authenticated) {
      return res.status(401).json({ code: "UNAUTHORIZED" });
    }

    return next();
  },
}));

vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireWorkspaceSession: (_req, _res, next) => next(),
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireLocationAccess: () => (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
}));

vi.mock("@/modules/tenant-access/tenant-access.permissions.js", () => ({
  WORKSPACE_PERMISSION: {
    BOOKINGS_CREATE: "bookings:create",
    BOOKINGS_VIEW: "bookings:view",
    BOOKINGS_UPDATE: "bookings:update",
    BOOKINGS_CANCEL: "bookings:cancel",
  },
}));

vi.mock("@/modules/booking/controllers/booking.course.controller.js", () => ({
  createCourseBookingRecords: mocks.createCourseBookingRecords,
}));

vi.mock("@/modules/booking/controllers/booking.read.controller.js", () => ({
  getBookings: mocks.getBookings,
  getBookingsByProductId: mocks.getBookingsByProductId,
  getBookingsByUserId: mocks.getBookingsByUserId,
  getBookingsHistory: mocks.getBookingsHistory,
  getBookingsWithFilters: mocks.getBookingsWithFilters,
  getUserBookings: mocks.getUserBookings,
}));

vi.mock("@/modules/booking/controllers/booking.write.controller.js", () => ({
  cancelBooking: mocks.cancelBooking,
  deleteBooking: mocks.deleteBooking,
  updateBooking: mocks.updateBooking,
}));

vi.mock("@/modules/booking/controllers/booking.editor.controller.js", () => ({
  readBookingEditor: mocks.readBookingEditor,
  writeBookingEditor: mocks.writeBookingEditor,
  lookupBookingEditorCustomer: mocks.lookupBookingEditorCustomer,
}));

import bookingRouter from "@/modules/booking/booking.routes.js";

const app = express();
app.use(express.json());
app.use("/bookings", bookingRouter);

describe("legacy booking participant-increase endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticated = true;
  });

  it("requires authentication before returning the migration response", async () => {
    mocks.authenticated = false;

    const response = await request(app)
      .put("/bookings/increase-participants")
      .send({
        bookingId: "64b000000000000000000205",
        additionalParticipants: 2,
      })
      .expect(401);

    expect(response.body).toEqual({ code: "UNAUTHORIZED" });
  });

  it("returns a stable 410 response and does not invoke a booking mutation", async () => {
    const response = await request(app)
      .put("/bookings/increase-participants")
      .send({
        bookingId: "64b000000000000000000205",
        additionalParticipants: 2,
      })
      .expect(410);

    expect(response.body).toEqual({
      message:
        "Booking participant increases must be completed through checkout.",
      code: "BOOKING_PARTICIPANT_INCREASE_REQUIRES_CHECKOUT",
      checkoutRequired: true,
    });
    expect(mocks.updateBooking).not.toHaveBeenCalled();
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    expect(mocks.deleteBooking).not.toHaveBeenCalled();
    expect(mocks.createCourseBookingRecords).not.toHaveBeenCalled();
    expect(mocks.writeBookingEditor).not.toHaveBeenCalled();
  });

  it("never restores the legacy mutation for a forged target user", async () => {
    const response = await request(app)
      .put("/bookings/increase-participants")
      .send({
        bookingId: "64b000000000000000000205",
        additionalParticipants: 1,
        userId: "64b000000000000000000999",
      })
      .expect(410);

    expect(response.body.code).toBe(
      "BOOKING_PARTICIPANT_INCREASE_REQUIRES_CHECKOUT",
    );
    expect(mocks.updateBooking).not.toHaveBeenCalled();
    expect(mocks.writeBookingEditor).not.toHaveBeenCalled();
  });
});
