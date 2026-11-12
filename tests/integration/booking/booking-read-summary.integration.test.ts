import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { listBookingsWithFilters } from "@/modules/booking/services/booking.read.service.js";
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
    });
    expect(second.summary).toEqual(first.summary);
    expect((await list({ ...filters, allowedLocationIds: [] })).totalCount).toBe(0);
    expect(
      (await list({ ...filters, locationId: String(otherLocationId) })).totalCount,
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
    });
    expect(
      (await list({ ...filters, dateFrom: "2026-10-31T10:00:00.000Z" }))
        .bookings.map((row) => String(row._id)),
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
    });
    expect(
      (await list({ ...filters, dateFrom: "2026-10-20", dateTo: "2026-10-20" }))
        .summary,
    ).toEqual({
      totalBookings: 1,
      todayBookings: 0,
      awaitingPaymentBookings: 0,
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
    });
    expect(
      (await list({ locationId: undefined, allowedLocationIds: [] })).summary,
    ).toEqual({
      totalBookings: 0,
      todayBookings: 0,
      awaitingPaymentBookings: 0,
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
});
