import mongoose from "mongoose";
import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  getBookingsWithFilters,
  getBookingFilterOptions,
} from "@/modules/booking/controllers/booking.read.controller.js";
import * as authorization from "@/modules/tenant-access/services/authorization.service.js";
import { buildOpenStudioBookingsToCreate } from "@/modules/checkout/services/checkout.cart.service.js";
import { processWorkshopBookingsAfterPayment } from "@/modules/checkout/services/checkout.workshop-fulfillment.service.js";
import StaffMember from "@/modules/staff/staff-member.model.js";
import Booking from "@/modules/booking/booking.model.js";
import {
  listBookingsWithFilters,
  listBookingFilterOptions,
} from "@/modules/booking/services/booking.read.service.js";
import { LocationModel } from "@/modules/location/location.model.js";
import { Product } from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const locationId = new mongoose.Types.ObjectId();
const otherLocationId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const otherProductId = new mongoose.Types.ObjectId();
const authorId = new mongoose.Types.ObjectId();

const booking = (start: string, overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant: tenantId,
  location: locationId,
  bookingProduct: productId,
  createdBy: authorId,
  author: { customId: "member-1" },
  lecturer: "Lecturer A",
  start: new Date(start),
  end: new Date(new Date(start).getTime() + 60 * 60 * 1000),
  status: "processed",
  paymentStatus: "CONFIRMED",
  ...overrides,
});

const list = (
  input: Parameters<typeof listBookingsWithFilters>[0]["input"] = {},
) =>
  listBookingsWithFilters({
    tenantId,
    input: { locationId: String(locationId), ...input },
  });

describe("booking list summaries", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await clearTestDatabase();
    await TenantModel.collection.insertOne({
      _id: tenantId,
      settings: { timezone: "UTC" },
    });
    await LocationModel.collection.insertOne({
      _id: locationId,
      tenant: tenantId,
      booking: { timezone: "Europe/Prague" },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T08:00:00.000Z"));
  });

  it("counts the entire selected location on every page, including today rows off page one", async () => {
    await Booking.collection.insertMany([
      ...Array.from({ length: 12 }, (_, index) =>
        booking(`2026-11-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`, {
          paymentStatus: index === 0 ? "PENDING_PAYMENT" : "CONFIRMED",
        }),
      ),
      booking("2026-10-19T13:30:00.000Z"),
      booking("2026-10-19T15:30:00.000Z", { paymentStatus: "PENDING_PAYMENT" }),
      booking("2026-10-19T17:30:00.000Z", { status: "cancelled" }),
      booking("2026-10-19T13:30:00.000Z", {
        tenant: otherTenantId,
        paymentStatus: "PENDING_PAYMENT",
      }),
      booking("2026-10-19T13:30:00.000Z", {
        location: otherLocationId,
        paymentStatus: "PENDING_PAYMENT",
      }),
    ]);

    const first = await list({ page: 1, limit: 10 });
    const second = await list({ page: 2, limit: 10 });
    expect(first.bookings).toHaveLength(10);
    expect(
      first.bookings.every((row) => row.start >= new Date("2026-11-01")),
    ).toBe(true);
    expect(second.bookings).toHaveLength(5);
    expect(first.summary).toEqual({
      totalBookings: 15,
      todayBookings: 3,
      awaitingPaymentBookings: 2,
      cancelledBookings: 1,
    });
    expect(second.summary).toEqual(first.summary);
    expect(first.totalCount).toBe(15);
    expect(first.totalPages).toBe(2);
  });

  it("includes ongoing and future bookings by end time before pagination and summary counts", async () => {
    const now = "2026-10-31T08:05:00.000Z"; // 09:05 in the selected studio.
    vi.setSystemTime(new Date(now));
    const ongoing = booking("2026-10-31T08:00:00.000Z", {
      end: new Date("2026-10-31T11:00:00.000Z"),
    });
    const startingNow = booking(now);
    const laterToday = booking("2026-10-31T14:00:00.000Z", {
      end: new Date("2026-10-31T16:00:00.000Z"),
    });
    const tomorrow = booking("2026-11-01T08:00:00.000Z", {
      paymentStatus: "PENDING_PAYMENT",
    });
    await Booking.collection.insertMany([
      ongoing,
      startingNow,
      laterToday,
      tomorrow,
      booking("2026-10-31T07:00:00.000Z", { end: new Date(now) }),
      ...[5, 6, 7].map((hour) =>
        booking(`2026-10-31T0${hour}:00:00.000Z`, { status: "cancelled" }),
      ),
      booking("2026-10-31T14:00:00.000Z", { tenant: otherTenantId }),
      booking("2026-10-31T14:00:00.000Z", { location: otherLocationId }),
    ]);

    const filters = {
      endAfter: now,
      allowedLocationIds: [String(locationId)],
      limit: 2,
      sortOrder: "asc" as const,
    };
    const first = await list({ ...filters, page: 1 });
    const second = await list({ ...filters, page: 2 });
    expect(first.bookings.map((row) => String(row._id))).toEqual(
      [ongoing, startingNow].map((row) => String(row._id)),
    );
    expect(second.bookings.map((row) => String(row._id))).toEqual(
      [laterToday, tomorrow].map((row) => String(row._id)),
    );
    expect(first.totalCount).toBe(4);
    expect(first.totalPages).toBe(2);
    expect(first.summary).toEqual({
      totalBookings: 4,
      todayBookings: 3,
      awaitingPaymentBookings: 1,
      cancelledBookings: 0,
    });
    expect(second.summary).toEqual(first.summary);
    expect(
      (await list({ ...filters, allowedLocationIds: [] })).totalCount,
    ).toBe(0);
    expect(
      (await list({ ...filters, locationId: String(otherLocationId) }))
        .totalCount,
    ).toBe(0);
  });

  it("intersects endAfter with explicit start dates and existing filters", async () => {
    const now = "2026-10-31T08:05:00.000Z";
    vi.setSystemTime(new Date(now));
    const ongoing = booking("2026-10-31T08:00:00.000Z");
    const laterToday = booking("2026-10-31T14:00:00.000Z");
    await Booking.collection.insertMany([
      ongoing,
      laterToday,
      booking("2026-10-31T06:00:00.000Z"),
      booking("2026-11-01T08:00:00.000Z"),
      booking("2026-10-31T14:00:00.000Z", { paymentStatus: "PENDING_PAYMENT" }),
      booking("2026-10-31T14:00:00.000Z", { bookingProduct: otherProductId }),
    ]);
    const filters = {
      endAfter: "2026-10-31T09:05:00+01:00",
      dateFrom: "2026-10-31",
      dateTo: "2026-10-31",
      paymentStatus: "CONFIRMED",
      productId: String(productId),
      authorId: String(authorId),
      lecturerId: "Lecturer A",
      search: "member-1",
      sortOrder: "asc" as const,
    };
    const result = await list(filters);
    expect(result.bookings.map((row) => String(row._id))).toEqual(
      [ongoing, laterToday].map((row) => String(row._id)),
    );
    expect(result.summary).toEqual({
      totalBookings: 2,
      todayBookings: 2,
      awaitingPaymentBookings: 0,
      cancelledBookings: 0,
    });
    expect(
      (
        await list({ ...filters, dateFrom: "2026-10-31T10:00:00.000Z" })
      ).bookings.map((row) => String(row._id)),
    ).toEqual([String(laterToday._id)]);
  });

  it("leaves unfiltered history intact and does not invent an end for malformed legacy rows", async () => {
    const missingEnd = booking("2026-11-01T08:00:00.000Z");
    const { end: _missingEnd, ...legacy } = missingEnd;
    const ended = booking("2026-10-30T08:00:00.000Z");
    const futureCancelled = booking("2026-11-01T09:00:00.000Z", {
      status: "cancelled",
    });
    await Booking.collection.insertMany([
      legacy,
      booking("2026-11-01T08:00:00.000Z", { end: null }),
      ended,
      futureCancelled,
    ]);
    expect((await list()).totalCount).toBe(4);
    const filtered = await list({ endAfter: "2026-10-31T08:05:00.000Z" });
    // This is only a time filter; existing status semantics stay unchanged.
    expect(filtered.bookings.map((row) => String(row._id))).toEqual([
      String(futureCancelled._id),
    ]);
  });

  it.each([
    "not-a-date",
    "2026-10-31",
    "2026-02-30T08:05:00.000Z",
    "2026-10-31T08:05:00",
    "",
    null,
    1793433900000,
    { $gt: "2026-10-31T08:05:00.000Z" },
  ])("rejects invalid endAfter %j as a bad request", async (endAfter) => {
    await expect(list({ endAfter } as never)).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
  });

  it("intersects all active filters instead of replacing date or payment criteria", async () => {
    await Booking.collection.insertMany([
      booking("2026-10-19T12:00:00.000Z"),
      booking("2026-10-19T13:00:00.000Z", { paymentStatus: "PENDING_PAYMENT" }),
      booking("2026-10-20T12:00:00.000Z"),
      booking("2026-10-19T12:00:00.000Z", { bookingProduct: otherProductId }),
      booking("2026-10-19T12:00:00.000Z", { lecturer: "Lecturer B" }),
      booking("2026-10-19T12:00:00.000Z", { author: { customId: "member-2" } }),
      booking("2026-10-19T12:00:00.000Z", {
        createdBy: new mongoose.Types.ObjectId(),
      }),
    ]);
    const filters = {
      search: "member-1",
      authorId: String(authorId),
      lecturerId: "Lecturer A",
      productId: String(productId),
      paymentStatus: "CONFIRMED",
      dateFrom: "2026-10-19",
      dateTo: "2026-10-19",
    };

    expect((await list(filters)).summary).toEqual({
      totalBookings: 1,
      todayBookings: 1,
      awaitingPaymentBookings: 0,
      cancelledBookings: 0,
    });
    expect(
      (await list({ ...filters, dateFrom: "2026-10-20", dateTo: "2026-10-20" }))
        .summary,
    ).toEqual({
      totalBookings: 1,
      todayBookings: 0,
      awaitingPaymentBookings: 0,
      cancelledBookings: 0,
    });
  });

  it("uses the selected studio's local date at UTC midnight, including exact day boundaries", async () => {
    vi.setSystemTime(new Date("2026-10-18T22:30:00.000Z"));
    await Booking.collection.insertMany([
      booking("2026-10-18T21:59:59.999Z"),
      booking("2026-10-18T22:00:00.000Z"),
      booking("2026-10-19T21:59:59.999Z"),
      booking("2026-10-19T22:00:00.000Z"),
    ]);
    expect((await list()).summary.todayBookings).toBe(2);
  });

  it("includes the full 25-hour local day when daylight saving time ends", async () => {
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    await Booking.collection.insertMany([
      booking("2026-10-24T21:59:59.999Z"),
      booking("2026-10-24T22:00:00.000Z"),
      booking("2026-10-25T22:59:59.999Z"),
      booking("2026-10-25T23:00:00.000Z"),
    ]);
    expect((await list()).summary.todayBookings).toBe(2);
  });

  it("uses the tenant timezone for an unselected location and keeps permission scope", async () => {
    vi.setSystemTime(new Date("2026-10-18T22:30:00.000Z"));
    await Booking.collection.insertMany([
      booking("2026-10-18T23:00:00.000Z", { paymentStatus: "PENDING_PAYMENT" }),
      booking("2026-10-19T12:00:00.000Z"),
      booking("2026-10-18T23:00:00.000Z", { location: otherLocationId }),
    ]);
    expect(
      (
        await list({
          locationId: undefined,
          allowedLocationIds: [String(locationId)],
        })
      ).summary,
    ).toEqual({
      totalBookings: 2,
      todayBookings: 1,
      awaitingPaymentBookings: 1,
      cancelledBookings: 0,
    });
    expect(
      (await list({ locationId: undefined, allowedLocationIds: [] })).summary,
    ).toEqual({
      totalBookings: 0,
      todayBookings: 0,
      awaitingPaymentBookings: 0,
      cancelledBookings: 0,
    });
  });

  it("returns zero summaries for unmatched customer and lecturer filters", async () => {
    await Booking.collection.insertOne(booking("2026-10-19T12:00:00.000Z"));
    for (const input of [
      { authorId: "missing-customer" },
      { lecturerId: String(new mongoose.Types.ObjectId()) },
    ]) {
      const result = await list(input);
      expect(result.bookings).toEqual([]);
      expect(result.summary).toEqual({
        totalBookings: 0,
        todayBookings: 0,
        awaitingPaymentBookings: 0,
        cancelledBookings: 0,
      });
    }
  });

  it("searches customer names, email, member number and product titles without crossing tenant or location scope", async () => {
    const foreignUserId = new mongoose.Types.ObjectId();
    const foreignProductId = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
      {
        _id: authorId,
        tenant: tenantId,
        firstname: "Marta",
        lastname: "Novak",
        email: "marta+pottery@example.test",
        memberNumber: 271,
        customId: "MN-27",
      },
      {
        _id: foreignUserId,
        tenant: otherTenantId,
        firstname: "Foreign",
        lastname: "Customer",
        email: "private@example.test",
      },
    ]);
    await Product.collection.insertMany([
      {
        _id: productId,
        tenant: tenantId,
        name: "Wheel throwing",
        label: "Evening pottery",
        isArchived: true,
      },
      {
        _id: foreignProductId,
        tenant: otherTenantId,
        name: "Foreign private class",
      },
    ]);
    const match = booking("2026-10-19T12:00:00.000Z");
    await Booking.collection.insertMany([
      match,
      booking("2026-10-19T13:00:00.000Z", { location: otherLocationId }),
      booking("2026-10-19T14:00:00.000Z", { tenant: otherTenantId }),
      booking("2026-10-19T15:00:00.000Z", {
        createdBy: foreignUserId,
        bookingProduct: foreignProductId,
      }),
    ]);
    for (const search of [
      "Marta Novak",
      "NOVAK",
      "marta+pottery@example.test",
      "271",
      "MN-27",
      "Wheel throwing",
      "Evening pottery",
      String(match._id),
    ]) {
      const result = await list({
        search,
        allowedLocationIds: [String(locationId)],
      });
      expect(result.bookings.map((row) => String(row._id))).toEqual([
        String(match._id),
      ]);
      expect(result.summary.totalBookings).toBe(1);
    }
    for (const search of [
      "Foreign Customer",
      "private@example.test",
      "Foreign private class",
      ".*",
    ]) {
      expect((await list({ search })).totalCount).toBe(0);
    }
    expect(
      (
        await list({
          search: "Marta",
          locationId: String(otherLocationId),
          allowedLocationIds: [String(locationId)],
        })
      ).totalCount,
    ).toBe(0);
    expect(
      (await list({ search: "Marta", allowedLocationIds: [] })).totalCount,
    ).toBe(0);
  });

  it("searches historical author snapshots and lecturer when related customer records are gone", async () => {
    const snapshot = booking("2026-10-19T12:00:00.000Z", {
      author: {
        name: "Historical Customer",
        email: "old+email@example.test",
        customId: "OLD.[12]",
        memberNumber: 812,
      },
      lecturer: "Guest Lecturer",
    });
    await Booking.collection.insertOne(snapshot);
    for (const search of [
      "historical customer",
      "old+email@example.test",
      "OLD.[12]",
      "812",
      "guest lecturer",
      String(productId),
      String(authorId),
    ]) {
      expect((await list({ search })).totalCount).toBe(1);
    }
    expect(
      (await list({ search: "Historical", paymentStatus: "PENDING_PAYMENT" }))
        .totalCount,
    ).toBe(0);
  });
  it("honors cancelled status before pagination and every intersected count", async () => {
    const cancelled = Array.from({ length: 13 }, () =>
      booking("2026-10-19T12:00:00.000Z", { status: "cancelled" }),
    );
    await Booking.collection.insertMany([
      ...cancelled,
      booking("2026-10-19T12:00:00.000Z"),
      booking("2026-10-19T12:00:00.000Z", {
        status: "cancelled",
        paymentStatus: "PENDING_PAYMENT",
      }),
      booking("2026-10-19T12:00:00.000Z", {
        status: "cancelled",
        tenant: otherTenantId,
      }),
      booking("2026-10-19T12:00:00.000Z", {
        status: "cancelled",
        location: otherLocationId,
      }),
    ]);
    const filters = {
      status: "cancelled",
      paymentStatus: "CONFIRMED",
      limit: 10,
    };
    const first = await list(filters);
    const second = await list({ ...filters, page: 2 });
    expect(first.bookings).toHaveLength(10);
    expect(second.bookings).toHaveLength(3);
    expect(
      [...first.bookings, ...second.bookings].every(
        (row) => row.status === "cancelled",
      ),
    ).toBe(true);
    expect(first.summary).toEqual({
      totalBookings: 13,
      todayBookings: 13,
      awaitingPaymentBookings: 0,
      cancelledBookings: 13,
    });
    expect(second.summary).toEqual(first.summary);
    expect(
      (await list({ ...filters, dateFrom: "2026-10-20" })).totalCount,
    ).toBe(0);
  });

  it.each(["unknown", "confirmed", null, ["cancelled"], { $ne: "cancelled" }])(
    "rejects unsupported status %j",
    async (status) => {
      await expect(list({ status } as never)).rejects.toMatchObject({
        statusCode: 400,
      });
    },
  );

  it("orders identical starts deterministically across pages in both directions using bounded indexed reads", async () => {
    const rows = Array.from({ length: 2005 }, () =>
      booking("2026-10-19T12:00:00.000Z"),
    );
    await Booking.collection.insertMany(rows);
    await Booking.createIndexes();
    for (const sortOrder of ["asc", "desc"] as const) {
      const expected = rows.map((row) => String(row._id)).sort();
      if (sortOrder === "desc") expected.reverse();
      const first = await list({ page: 1, limit: 10, sortOrder });
      const second = await list({ page: 2, limit: 10, sortOrder });
      const last = await list({ page: 201, limit: 10, sortOrder });
      expect(first.bookings.map((row) => String(row._id))).toEqual(
        expected.slice(0, 10),
      );
      expect(second.bookings.map((row) => String(row._id))).toEqual(
        expected.slice(10, 20),
      );
      expect(last.bookings.map((row) => String(row._id))).toEqual(
        expected.slice(2000),
      );
      expect(first.totalCount).toBe(2005);
    }
    for (const scope of [
      { tenant: tenantId, location: locationId },
      { tenant: tenantId },
    ]) {
      const explain = await Booking.find(scope)
        .sort({ start: -1, _id: -1 })
        .limit(10)
        .explain("executionStats");
      expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain(
        '"stage":"SORT"',
      );
      expect(explain.executionStats.nReturned).toBe(10);
      expect(explain.executionStats.totalDocsExamined).toBe(10);
      expect(explain.executionStats.totalKeysExamined).toBe(10);
    }
  });

  it("populates only page identities from the same tenant and omits booking internals", async () => {
    const foreignLocation = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
      {
        _id: authorId,
        tenant: tenantId,
        firstname: "Local",
        lastname: "Customer",
        email: "local@example.test",
        password: "hidden",
      },
      {
        _id: otherProductId,
        tenant: otherTenantId,
        firstname: "Private",
        email: "private@example.test",
      },
    ]);
    await Product.collection.insertMany([
      {
        _id: productId,
        tenant: tenantId,
        name: "Local class",
        price: 100,
        currency: "CZK",
        note: "hidden",
      },
      { _id: otherProductId, tenant: otherTenantId, name: "Private class" },
    ]);
    await LocationModel.collection.insertOne({
      _id: foreignLocation,
      tenant: otherTenantId,
      name: "Private location",
    });
    const local = booking("2026-10-19T12:00:00.000Z", {
      totalPrice: 75,
      currency: "CZK",
      participants: [{ email: "participant@example.test" }],
      accessCode: "hidden",
      note: "private note",
      importMetadata: { externalId: "private-id" },
    });
    const corrupt = booking("2026-10-19T13:00:00.000Z", {
      createdBy: otherProductId,
      bookingProduct: otherProductId,
      location: foreignLocation,
    });
    await Booking.collection.insertMany([local, corrupt]);
    const result = await list({ locationId: undefined });
    const own = result.bookings.find(
      (row) => String(row._id) === String(local._id),
    );
    const invalid = result.bookings.find(
      (row) => String(row._id) === String(corrupt._id),
    );
    expect(own).toMatchObject({
      totalPrice: 75,
      currency: "CZK",
      createdBy: { firstname: "Local", email: "local@example.test" },
      bookingProduct: { name: "Local class", currency: "CZK" },
    });
    expect(invalid).toMatchObject({
      createdBy: null,
      bookingProduct: null,
      location: null,
    });
    for (const field of [
      "participants",
      "accessCode",
      "note",
      "importMetadata",
    ])
      expect(own).not.toHaveProperty(field);
    expect(own?.createdBy).not.toHaveProperty("password");
    expect(own?.bookingProduct).not.toHaveProperty("note");
  });

  it("reuses protected request access and cannot accept a client-provided location scope", async () => {
    await Booking.collection.insertMany([
      booking("2026-10-19T12:00:00.000Z"),
      booking("2026-10-19T12:00:00.000Z", { location: otherLocationId }),
      booking("2026-10-19T12:00:00.000Z", { tenant: otherTenantId }),
    ]);
    const resolve = vi.spyOn(authorization, "resolveWorkspaceAccessForUser");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.assign(req, {
        userInfo: { tenant: String(tenantId) },
        workspaceAccess: req.get("x-no-access")
          ? null
          : {
              tenantId: String(tenantId),
              status: "active",
              locationAccess: {
                mode: "selected",
                locationIds: [String(locationId)],
              },
            },
      });
      next();
    });
    app.post("/bookings/filter", getBookingsWithFilters);
    app.get("/bookings/filter-options", getBookingFilterOptions);
    app.use(
      (
        error: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(error.statusCode || 500).json({ code: error.code }),
    );
    const allowed = await request(app)
      .post("/bookings/filter")
      .send({ allowedLocationIds: [String(otherLocationId)] })
      .expect(200);
    expect(allowed.body.totalCount).toBe(1);
    await request(app)
      .post("/bookings/filter")
      .send({ locationId: { $ne: String(otherLocationId) } })
      .expect(400);
    await request(app)
      .post("/bookings/filter")
      .send({ locationId: String(otherLocationId), allowedLocationIds: null })
      .expect(404);
    await request(app)
      .post("/bookings/filter")
      .set("x-no-access", "1")
      .send({})
      .expect(403);
    await request(app)
      .get("/bookings/filter-options")
      .query({ locationId: String(otherLocationId) })
      .expect(404);
    await request(app)
      .get("/bookings/filter-options")
      .query({ allowedLocationIds: String(otherLocationId) })
      .expect(400);
    await request(app)
      .get("/bookings/filter-options")
      .set("x-no-access", "1")
      .expect(403);
    const options = await request(app)
      .get("/bookings/filter-options")
      .expect(200);
    expect(options.body.lecturers).toEqual([
      { value: "Lecturer A", label: "Lecturer A" },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each(["pending", "processed", "delivered", "completed", "cancelled"])(
    "filters the actual stored lifecycle state %s",
    async (status) => {
      await Booking.collection.insertMany(
        ["pending", "processed", "delivered", "completed", "cancelled"].map(
          (value) => booking("2026-10-19T12:00:00.000Z", { status: value }),
        ),
      );
      const result = await list({ status });
      expect(result.totalCount).toBe(1);
      expect(result.bookings[0].status).toBe(status);
      expect(result.summary.cancelledBookings).toBe(
        status === "cancelled" ? 1 : 0,
      );
    },
  );

  it("finds real credit and card fulfillment under paid, while pending/failed/expired remain separate", async () => {
    const orderId = new mongoose.Types.ObjectId();
    const product = {
      _id: productId,
      type: "workshop",
      kind: "open-studio",
      bookingMode: "private",
      maxNumberOfParticipants: 4,
    };
    const cart = {
      product,
      locationId: String(locationId),
      start: new Date("2026-10-19T12:00:00Z"),
      end: new Date("2026-10-19T13:00:00Z"),
      numberOfGuests: 1,
      bookingMode: "private",
    };
    const create = (paymentMode: string) =>
      buildOpenStudioBookingsToCreate({
        cartItems: [cart],
        productById: new Map([[String(productId), product]]),
        user: { _id: authorId, firstname: "Paid", customId: "MEMBER" },
        orderId,
        paymentMode,
      })[0];
    const credits = {
      ...create("credits"),
      _id: new mongoose.Types.ObjectId(),
      tenant: tenantId,
    };
    const card = {
      ...create("stripe"),
      _id: new mongoose.Types.ObjectId(),
      tenant: tenantId,
    };
    await Booking.collection.insertMany([credits, card]);
    await processWorkshopBookingsAfterPayment(
      { _id: orderId, workshopBookings: [card._id] },
      { tenantId },
    );
    await Booking.collection.insertMany(
      ["PENDING_PAYMENT", "FAILED", "EXPIRED"].map((paymentStatus) =>
        booking("2026-10-19T12:00:00Z", { paymentStatus, status: "pending" }),
      ),
    );
    const paid = await list({ paymentStatus: "CONFIRMED" });
    expect(paid.bookings.map((row) => String(row._id)).sort()).toEqual(
      [String(credits._id), String(card._id)].sort(),
    );
    expect(paid.bookings.every((row) => row.status === "processed")).toBe(true);
    for (const paymentStatus of ["PENDING_PAYMENT", "FAILED", "EXPIRED"]) {
      const result = await list({ paymentStatus });
      expect(result.totalCount).toBe(1);
      expect(result.bookings[0].paymentStatus).toBe(paymentStatus);
      expect(result.summary.awaitingPaymentBookings).toBe(
        paymentStatus === "PENDING_PAYMENT" ? 1 : 0,
      );
    }
  });

  it.each([
    { paymentStatus: "CREDITS" },
    { paymentStatus: "REFUNDED" },
    { paymentStatus: { $ne: "CONFIRMED" } },
    { productId: "not-an-id" },
    { search: { $ne: "" } },
    { dateFrom: "2026-02-30" },
    { dateTo: "not-a-date" },
    { dateFrom: "2026-10-20", dateTo: "2026-10-19" },
    { dateScope: "all" },
    { lecturerName: "A", lecturerId: "B" },
    { page: "1garbage" },
    { limit: 101 },
  ])(
    "rejects invalid filter values instead of silently widening results: %j",
    async (input) => {
      await expect(list(input as never)).rejects.toMatchObject({
        statusCode: 400,
      });
    },
  );

  it("uses the public #member parser without collapsing padded legacy identifiers", async () => {
    const legacyId = new mongoose.Types.ObjectId();
    await User.collection.insertMany([
      {
        _id: authorId,
        tenant: tenantId,
        firstname: "Member",
        customId: "NORMAL",
        memberNumber: 234,
      },
      {
        _id: legacyId,
        tenant: tenantId,
        firstname: "Legacy",
        customId: "0234",
        memberNumber: 900,
      },
    ]);
    const member = booking("2026-10-19T12:00:00Z", {
      author: { customId: "NORMAL", memberNumber: 234 },
    });
    const legacy = booking("2026-10-19T12:00:00Z", {
      createdBy: legacyId,
      author: { customId: "0234", memberNumber: 900 },
    });
    await Booking.collection.insertMany([member, legacy]);
    for (const input of [
      { search: "#234" },
      { authorId: "#234" },
      { authorId: "234" },
    ]) {
      expect(
        (await list(input)).bookings.map((row) => String(row._id)),
      ).toEqual([String(member._id)]);
    }
    for (const input of [{ search: "0234" }, { authorId: "0234" }]) {
      expect(
        (await list(input)).bookings.map((row) => String(row._id)),
      ).toEqual([String(legacy._id)]);
    }
  });

  it.each([
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T21:59:59.999Z"],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T22:59:59.999Z"],
  ])(
    "date-only filters include exactly the studio's DST day %s",
    async (day, first, last) => {
      await Booking.collection.insertMany([
        booking(new Date(new Date(first).getTime() - 1).toISOString()),
        booking(first),
        booking(last),
        booking(new Date(new Date(last).getTime() + 1).toISOString()),
      ]);
      const result = await list({
        dateFrom: day,
        dateTo: day,
        sortOrder: "asc",
      });
      expect(result.bookings.map((row) => row.start.toISOString())).toEqual([
        first,
        last,
      ]);
      expect(result.totalCount).toBe(2);
      const exact = await list({ dateFrom: first, dateTo: first });
      expect(exact.totalCount).toBe(1);
      expect(exact.bookings[0].start.toISOString()).toBe(first);
    },
  );

  it("server today uses the selected studio's day and intersects every explicit filter", async () => {
    vi.setSystemTime(new Date("2026-10-18T22:30:00Z"));
    const match = booking("2026-10-18T23:00:00Z", {
      status: "cancelled",
      lecturer: "A.[x]",
    });
    await Booking.collection.insertMany([
      match,
      booking("2026-10-19T22:00:00Z", {
        status: "cancelled",
        lecturer: "A.[x]",
      }),
      booking("2026-10-18T23:00:00Z", {
        status: "cancelled",
        lecturer: "A.[x] suffix",
      }),
      booking("2026-10-18T23:00:00Z", {
        status: "processed",
        lecturer: "A.[x]",
      }),
      booking("2026-10-18T23:00:00Z", {
        status: "cancelled",
        lecturer: "A.[x]",
        paymentStatus: "PENDING_PAYMENT",
      }),
      booking("2026-10-18T23:00:00Z", {
        status: "cancelled",
        lecturer: "A.[x]",
        bookingProduct: otherProductId,
      }),
      booking("2026-10-18T23:00:00Z", {
        status: "cancelled",
        lecturer: "A.[x]",
        location: otherLocationId,
      }),
    ]);
    const input = {
      dateScope: "today" as const,
      endAfter: "2026-10-18T22:30:00Z",
      status: "cancelled",
      lecturerName: "A.[x]",
      productId: String(productId),
      paymentStatus: "CONFIRMED",
    };
    const result = await list(input);
    expect(result.bookings.map((row) => String(row._id))).toEqual([
      String(match._id),
    ]);
    expect(result.summary).toEqual({
      totalBookings: 1,
      todayBookings: 1,
      cancelledBookings: 1,
      awaitingPaymentBookings: 0,
    });
    expect((await list({ ...input, dateFrom: "2026-10-20" })).totalCount).toBe(
      0,
    );
  });

  it("retains scoped legacy lecturer IDs while exact snapshot names avoid partial matches", async () => {
    const staffId = new mongoose.Types.ObjectId();
    await StaffMember.collection.insertOne({
      _id: staffId,
      tenantId,
      firstName: "Anna",
      lastName: "Teacher",
    });
    const match = booking("2026-10-19T12:00:00Z", { lecturer: "Anna Teacher" });
    await Booking.collection.insertMany([
      match,
      booking("2026-10-19T12:00:00Z", { lecturer: "Anna Teacher Assistant" }),
    ]);
    expect(
      (await list({ lecturerId: String(staffId) })).bookings.map((row) =>
        String(row._id),
      ),
    ).toEqual([String(match._id)]);
    expect((await list({ lecturerName: "Anna Teacher" })).totalCount).toBe(1);
    expect((await list({ lecturerName: "Teacher" })).totalCount).toBe(0);
  });

  it("returns complete narrow booking-derived options beyond 100 without leaking another tenant/location or catalog-only products", async () => {
    const products = Array.from({ length: 125 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      tenant: tenantId,
      name: `Booked ${index}`,
      kind: "class",
      isArchived: index === 124,
      privateNote: "hidden",
    }));
    const foreignProduct = new mongoose.Types.ObjectId();
    const scopedOutProduct = new mongoose.Types.ObjectId();
    await Product.collection.insertMany([
      ...products,
      { _id: foreignProduct, tenant: otherTenantId, name: "Foreign" },
      { _id: scopedOutProduct, tenant: tenantId, name: "Other location" },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant: tenantId,
        name: "Never booked",
      },
    ]);
    await Booking.collection.insertMany([
      ...products.map((product, index) =>
        booking("2025-01-01T12:00:00Z", {
          bookingProduct: product._id,
          lecturer: `Teacher ${index}`,
        }),
      ),
      booking("2025-01-01T12:00:00Z", {
        bookingProduct: foreignProduct,
        lecturer: "Teacher 0",
      }),
      booking("2025-01-01T12:00:00Z", {
        bookingProduct: foreignProduct,
        tenant: otherTenantId,
        lecturer: "Foreign teacher",
      }),
      booking("2025-01-01T12:00:00Z", {
        bookingProduct: scopedOutProduct,
        location: otherLocationId,
        lecturer: "Other location teacher",
      }),
    ]);
    const context = { tenantId, allowedLocationIds: [String(locationId)] };
    const options = await listBookingFilterOptions(context);
    expect(options.products).toHaveLength(125);
    expect(options.lecturers).toHaveLength(125);
    expect(
      options.products.some((product) => product.name === "Booked 124"),
    ).toBe(true);
    expect(
      options.products.every(
        (product) => Object.keys(product).sort().join() === "_id,kind,name",
      ),
    ).toBe(true);
    expect(
      options.lecturers.every(
        (lecturer) => Object.keys(lecturer).sort().join() === "label,value",
      ),
    ).toBe(true);
    expect(
      options.lecturers.some((lecturer) =>
        /Foreign|Other location/.test(lecturer.label),
      ),
    ).toBe(false);
    expect(
      await listBookingFilterOptions({ tenantId, allowedLocationIds: [] }),
    ).toEqual({ products: [], lecturers: [] });
    expect(
      await listBookingFilterOptions({
        ...context,
        locationId: String(otherLocationId),
      }),
    ).toEqual({ products: [], lecturers: [] });
  });
});
