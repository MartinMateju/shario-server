import mongoose from "mongoose";
import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Location from "@/modules/location/location.model.js";
import Booking from "@/modules/booking/booking.model.js";
import Order from "@/modules/order/order.model.js";
import { BookingCancellationEvent } from "@/modules/booking/booking-cancellation-event.model.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ReportContext } from "@/modules/reports/reports.types.js";
import {
  listReportCustomers,
  prepareReportCustomers,
  iterateReportCustomerRows,
  matchesReportCustomer,
} from "@/modules/reports/reports.customer-service.js";
import { exportReportCustomersCsv } from "@/modules/reports/reports.customer-controller.js";
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const oid = () => new mongoose.Types.ObjectId();
const tenant = oid(),
  foreignTenant = oid(),
  location = oid(),
  otherLocation = oid(),
  actor = oid();
const now = new Date("2026-11-17T12:00:00Z");
const period = { from: "2026-11-01", to: "2026-11-17" };
const context = (patch: any = {}): ReportContext => ({
  tenantId: String(tenant),
  userId: String(actor),
  access: {
    tenantId: String(tenant),
    userId: String(actor),
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
    ...patch,
  } as any,
});
let personSequence = 0;
const person = (patch: any = {}) => ({
  _id: oid(),
  tenant,
  tenantRole: "customer",
  platformRole: "none",
  firstname: "Ada",
  lastname: "Customer",
  email: `ada${++personSequence}@example.test`,
  customId: `U-${personSequence}`,
  memberNumber: personSequence,
  moneyCredits: 10,
  moneyCreditsMinor: 1000,
  createdAt: new Date("2025-01-01Z"),
  password: "must-not-leak",
  refreshToken: ["secret"],
  guestContact: { email: "private@example.test" },
  ...patch,
});
const order = (customer: any, patch: any = {}) => ({
  _id: oid(),
  tenant,
  createdBy: customer,
  isPaid: true,
  status: "processed_order",
  currency: "CZK",
  paidAt: new Date("2026-11-03T12:00:00Z"),
  paidAmountMinor: 10000,
  grossAmountMinor: 10000,
  locationIds: [location],
  lineItems: [{ grossAmountMinor: 10000, location, quantity: 1 }],
  ...patch,
});
const booking = (customer: any, patch: any = {}) => ({
  _id: oid(),
  tenant,
  location,
  createdBy: customer,
  tag: "open-studio",
  status: "cancelled",
  paymentStatus: "CONFIRMED",
  start: new Date("2027-01-01T12:00:00Z"),
  end: new Date("2027-01-01T13:00:00Z"),
  ...patch,
});
const event = (customer: any, bookingId: any, patch: any = {}) => ({
  _id: String(oid()),
  tenant,
  location,
  customer,
  booking: bookingId,
  actor,
  actorType: "staff",
  source: "open_studio",
  occurredAt: new Date("2026-11-05T12:00:00Z"),
  seats: 1,
  ...patch,
});
const courseEvent = (
  customer: any,
  bookingId: any,
  orderId: any,
  ordinal = 0,
  patch: any = {},
) =>
  event(customer, bookingId, {
    _id: `${tenant}:course:${orderId}:${bookingId}:${ordinal}`,
    source: "course_participant",
    order: orderId,
    ...patch,
  });
const list = (input: any = {}, accessPatch: any = {}) =>
  listReportCustomers({
    context: context(accessPatch),
    input: { ...period, ...input },
    now,
  });
const exportRows = async (input: any) => {
  const p = await prepareReportCustomers({
    context: context(),
    input: { ...period, ...input },
    now,
  });
  const rows: any[] = [];
  for await (const batch of iterateReportCustomerRows(p))
    rows.push(...batch.filter((row) => matchesReportCustomer(row, p)));
  return rows;
};
const app = express();
app.use((req, _res, next) => {
  Object.assign(req, {
    userInfo: { tenant: String(tenant), id: String(actor) },
    workspaceAccess: context().access,
  });
  next();
});
app.get("/reports/customers/export.csv", exportReportCustomersCsv);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 400).json({ code: error.code }),
);

describe("customer report segmentation", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all(
      [User, Tenant, Location, Booking, Order, BookingCancellationEvent].map(
        (model) => model.init(),
      ),
    );
  });
  afterAll(disconnectTestDatabase);
  beforeEach(async () => {
    await clearTestDatabase();
    await Tenant.collection.insertOne({
      _id: tenant,
      plan: "professional",
      planVersion: 1,
      modules: {
        customers: true,
        payments: true,
        bookings: true,
        credits: true,
        vouchers: true,
        memberships: true,
      },
      settings: { currency: "CZK", timezone: "Europe/Prague" },
    } as any);
    await Location.collection.insertMany([
      { _id: location, tenant, slug: "first", code: "first" },
      { _id: otherLocation, tenant, slug: "second", code: "second" },
    ] as any);
  });
  it("combines independent date and numeric bounds before page/count, exports every match beyond page one, and positively projects rows", async () => {
    const users = Array.from({ length: 125 }, (_, i) =>
      person({
        memberNumber: i + 1,
        createdAt: new Date(Date.UTC(2025, 0, i + 1)),
      }),
    );
    await User.collection.insertMany(users);
    const eligible = users.slice(0, 65);
    await Order.collection.insertMany(
      users.map((u, i) =>
        order(u._id, {
          paidAmountMinor: i < 65 ? 15000 : 5000,
          grossAmountMinor: i < 65 ? 15000 : 5000,
        }),
      ),
    );
    const bookings = eligible.map((u) => booking(u._id));
    await Booking.collection.insertMany(bookings);
    await BookingCancellationEvent.collection.insertMany(
      bookings.map((b) => event(b.createdBy, b._id)),
    );
    const filters = {
      spendMin: 100,
      spendMax: 200,
      creditMin: 5,
      creditMax: 15,
      cancelledMin: 1,
      cancelledMax: 1,
      cancellationActor: "staff",
      spendFrom: "2026-11-01",
      spendTo: "2026-11-04",
      cancellationFrom: "2026-11-05",
      cancellationTo: "2026-11-05",
    };
    const result = await list({ ...filters, page: 2, limit: 50 });
    expect(result).toMatchObject({
      totalCount: 65,
      currentPage: 2,
      pageSize: 50,
      totalPages: 2,
    });
    expect(result.data).toHaveLength(15);
    expect(result.data.map((u) => u.memberNumber)).toEqual(
      Array.from({ length: 15 }, (_, i) => 15 - i),
    );
    expect(result.data[0]).toMatchObject({
      paidSpendMinor: 15000,
      currentCreditMinor: 1000,
      cancelledBookings: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /must-not-leak|refreshToken|private@example/,
    );
    const rows = await exportRows(filters);
    expect(rows).toHaveLength(65);
    expect(new Set(rows.map((row) => row.id)).size).toBe(65);
    const csv = await request(app)
      .get("/reports/customers/export.csv")
      .query({ ...period, ...filters })
      .expect(200);
    expect(csv.text.trim().split(/\r?\n/)).toHaveLength(66);
    expect(csv.text).toContain(String(eligible[0]._id));
    expect(csv.text).not.toContain(String(users[124]._id));
  });
  it("enriches only the requested page for 1,605 customers and pushes wallet bounds before financial queries", async () => {
    const users = Array.from({ length: 1605 }, (_, i) =>
      person({
        moneyCredits: 0,
        moneyCreditsMinor: i === 0 ? 1000 : 0,
        createdAt: new Date(Date.UTC(2020, 0, i + 1)),
      }),
    );
    await User.collection.insertMany(users);
    const orderReads = vi.spyOn(Order, "find");
    const cancellationReads = vi.spyOn(BookingCancellationEvent, "aggregate");
    const result = await list({ page: 2, limit: 10 });
    expect(result.totalCount).toBe(1605);
    expect(result.data).toHaveLength(10);
    const pageIds = new Set(result.data.map((row) => row.id));
    const queriedIds = orderReads.mock.calls
      .flatMap(([query]: any[]) => query.createdBy?.$in ?? [])
      .map(String);
    expect(new Set(queriedIds)).toEqual(pageIds);
    expect(queriedIds).toHaveLength(10);
    expect(
      cancellationReads.mock.calls[0][0][0].$match.customer.$in.map(String),
    ).toEqual([...pageIds]);
    orderReads.mockClear();
    const creditFiltered = await list({ creditMin: 1 });
    expect(creditFiltered.data.map((row) => row.id)).toEqual([
      String(users[0]._id),
    ]);
    expect(
      orderReads.mock.calls
        .flatMap(([query]: any[]) => query.createdBy?.$in ?? [])
        .map(String),
    ).toEqual([String(users[0]._id)]);
  });
  it("distinguishes zero activity from unknown payment evidence and uses confirmed provider refunds once", async () => {
    const [zero, unknown, refunded, foreignCurrency] = Array.from(
      { length: 4 },
      () => person(),
    );
    await User.collection.insertMany([
      zero,
      unknown,
      refunded,
      foreignCurrency,
    ]);
    await Order.collection.insertMany([
      order(unknown._id, { paidAt: null }),
      order(refunded._id, {
        refund: {
          reconciliationId: "real-projection",
          status: "full",
          succeededAmountMinor: 10000,
          pendingAmountMinor: 0,
          failedAmountMinor: 0,
          reviewRequired: false,
          snapshotVersion: "v1",
          updatedAt: now,
        },
      }),
      order(foreignCurrency._id, { currency: "EUR" }),
    ]);
    const result = await list({ spendMin: 0, spendMax: 0 });
    expect(new Set(result.data.map((row) => row.id))).toEqual(
      new Set([String(zero._id), String(refunded._id)]),
    );
    const unfiltered = await list();
    expect(
      unfiltered.data.find((row) => row.id === String(unknown._id))
        ?.paidSpendMinor,
    ).toBeNull();
    expect(
      unfiltered.data.find((row) => row.id === String(foreignCurrency._id))
        ?.paidSpendMinor,
    ).toBeNull();
  });
  it("counts cancellation operation dates and initiators, deduplicates new and legacy course evidence, and leaves undated history unknown", async () => {
    const [tracked, legacy, classCustomer, outside] = Array.from(
      { length: 4 },
      () => person(),
    );
    await User.collection.insertMany([tracked, legacy, classCustomer, outside]);
    const first = booking(tracked._id),
      second = booking(tracked._id),
      old = booking(legacy._id),
      classBooking = booking(actor, { tag: "course", status: "processed" }),
      out = booking(outside._id);
    await Booking.collection.insertMany([
      first,
      second,
      old,
      classBooking,
      out,
    ]);
    const classOrder = order(classCustomer._id, {
      courseCancellations: [
        {
          bookingId: classBooking._id,
          quantity: 3,
          actor,
          refundedAt: new Date("2026-11-05T12:00:00Z"),
        },
      ],
    });
    await Order.collection.insertOne(classOrder);
    await BookingCancellationEvent.collection.insertMany([
      event(tracked._id, first._id, {
        actorType: "customer",
        actor: tracked._id,
      }),
      event(tracked._id, first._id, {
        actorType: "customer",
        actor: tracked._id,
        seats: 2,
      }),
      event(tracked._id, second._id),
      courseEvent(classCustomer._id, classBooking._id, classOrder._id),
      event(outside._id, out._id, {
        occurredAt: new Date("2026-10-05T12:00:00Z"),
      }),
    ]);
    expect(
      (await list({ cancellationActor: "customer", cancelledMin: 1 })).data.map(
        (row) => row.id,
      ),
    ).toEqual([String(tracked._id)]);
    const all = await list();
    expect(
      all.data.find((row) => row.id === String(tracked._id))?.cancelledBookings,
    ).toBe(2);
    expect(
      all.data.find((row) => row.id === String(classCustomer._id))
        ?.cancelledBookings,
    ).toBe(1);
    expect(
      all.data.find((row) => row.id === String(legacy._id))?.cancelledBookings,
    ).toBeNull();
    expect(
      all.data.find((row) => row.id === String(outside._id))?.cancelledBookings,
    ).toBe(0);
    expect((await list({ cancelledMax: 0 })).data.map((row) => row.id)).toEqual(
      [String(outside._id)],
    );
    expect(all.metadata.cancellationCoverage.complete).toBe(false);
    // Unknown historical dates do not hide a newer, positively proven event.
    const recentLegacyCustomerBooking = booking(legacy._id);
    await Booking.collection.insertOne(recentLegacyCustomerBooking);
    await BookingCancellationEvent.collection.insertOne(
      event(legacy._id, recentLegacyCustomerBooking._id),
    );
    const minimum = await list({ cancelledMin: 1 });
    expect(
      minimum.data.find((row) => row.id === String(legacy._id)),
    ).toMatchObject({
      cancelledBookings: null,
      recordedCancelledBookings: 1,
      cancellationHistoryComplete: false,
    });
    expect(
      (await list({ cancelledMin: 1, cancelledMax: 2 })).data.map(
        (row) => row.id,
      ),
    ).not.toContain(String(legacy._id));
  });
  it("keeps course cancellation events in their operation studio after an empty session moves", async () => {
    const user = person();
    const session = booking(actor, { tag: "class", status: "processed" });
    const paidOrder = order(user._id, {
      courseCancellations: [
        {
          bookingId: session._id,
          quantity: 1,
          actor,
          refundedAt: new Date("2026-11-05T12:00:00Z"),
        },
      ],
    });
    await User.collection.insertOne(user);
    await Booking.collection.insertOne(session);
    await Order.collection.insertOne(paidOrder);
    await BookingCancellationEvent.collection.insertOne(
      courseEvent(user._id, session._id, paidOrder._id),
    );
    // Import-owned sessions with no remaining orders can change studios.
    await Booking.collection.updateOne(
      { _id: session._id },
      { $set: { location: otherLocation } },
    );
    const filters = {
      cancellationFrom: "2026-11-05",
      cancellationTo: "2026-11-05",
    };
    for (const cancellationActor of ["all", "staff", "customer"]) {
      const original = await list({
        ...filters,
        cancellationActor,
        locationId: String(location),
      });
      expect(original.data[0].cancelledBookings).toBe(
        cancellationActor === "customer" ? 0 : 1,
      );
      const moved = await list({
        ...filters,
        cancellationActor,
        locationId: String(otherLocation),
      });
      expect(moved.data[0].cancelledBookings).toBe(0);
    }
    const movedFilters = {
      ...filters,
      cancellationActor: "staff",
      locationId: String(otherLocation),
      cancelledMin: 1,
    };
    expect((await list(movedFilters)).totalCount).toBe(0);
    expect(await exportRows(movedFilters)).toEqual([]);
    const restricted = await list(filters, {
      locationAccess: {
        mode: "selected",
        locationIds: [String(otherLocation)],
      },
    });
    expect(restricted.data[0].cancelledBookings).toBe(0);
  });
  it("prefers each immutable operation while preserving unmatched older partial cancellation history", async () => {
    const user = person();
    const session = booking(actor, {
      tag: "class",
      status: "processed",
      location: otherLocation,
    });
    const snapshot = (refundedAt: string) => ({
      bookingId: session._id,
      quantity: 1,
      actor,
      refundedAt: new Date(refundedAt),
    });
    const paidOrder = order(user._id, {
      courseCancellations: [
        snapshot("2026-10-05T12:00:00Z"),
        // A later snapshot edit must not override the event's November 5 date.
        snapshot("2026-11-06T12:00:00Z"),
      ],
    });
    await User.collection.insertOne(user);
    await Booking.collection.insertOne(session);
    await Order.collection.insertOne(paidOrder);
    await BookingCancellationEvent.collection.insertOne(
      courseEvent(user._id, session._id, paidOrder._id, 1),
    );
    const onDay = (day: string, locationId: any) =>
      list({
        cancellationFrom: day,
        cancellationTo: day,
        cancellationActor: "staff",
        locationId: String(locationId),
      });
    expect((await onDay("2026-10-05", otherLocation)).data[0]).toMatchObject({
      cancelledBookings: 1,
      cancellationHistoryComplete: true,
    });
    expect(
      (await onDay("2026-11-05", location)).data[0].cancelledBookings,
    ).toBe(1);
    for (const studio of [location, otherLocation])
      expect(
        (await onDay("2026-11-06", studio)).data[0].cancelledBookings,
      ).toBe(0);

    // A canonical event also supplies the evidence for its malformed snapshot.
    await Order.collection.updateOne(
      { _id: paidOrder._id },
      { $unset: { "courseCancellations.1.refundedAt": "" } },
    );
    expect((await onDay("2026-10-05", otherLocation)).data[0]).toMatchObject({
      cancelledBookings: 1,
      cancellationHistoryComplete: true,
    });
    // It cannot supply the missing evidence for a different, older operation.
    await Order.collection.updateOne(
      { _id: paidOrder._id },
      { $unset: { "courseCancellations.0.refundedAt": "" } },
    );
    expect((await onDay("2026-10-05", otherLocation)).data[0]).toMatchObject({
      cancelledBookings: null,
      cancellationHistoryComplete: false,
    });
  });
  it("scopes tenant, identity and locations without leaking payment or cancellation records", async () => {
    const own = person(),
      foreign = person({ tenant: foreignTenant }),
      staff = person({ tenantRole: "admin" });
    await User.collection.insertMany([own, foreign, staff]);
    await Order.collection.insertMany([
      order(own._id, { tenant: foreignTenant }),
      order(own._id, {
        locationIds: [otherLocation],
        lineItems: [{ grossAmountMinor: 10000, location: otherLocation }],
      }),
    ]);
    const b = booking(own._id, { location: otherLocation });
    await Booking.collection.insertOne(b);
    await BookingCancellationEvent.collection.insertMany([
      event(own._id, b._id, { location: otherLocation }),
      event(own._id, oid(), { tenant: foreignTenant }),
    ]);
    const result = await list({ locationId: String(location) });
    expect(result.totalCount).toBe(1);
    expect(result.data[0]).toMatchObject({
      id: String(own._id),
      paidSpendMinor: 0,
      cancelledBookings: 0,
    });
    await expect(
      list({}, { tenantId: String(foreignTenant) }),
    ).rejects.toThrow();
    await expect(
      list(
        { locationId: String(otherLocation) },
        {
          locationAccess: { mode: "selected", locationIds: [String(location)] },
        },
      ),
    ).rejects.toThrow();
  });
  it("masks denied metric domains and rejects numeric filters instead of pretending denied data is zero", async () => {
    await User.collection.insertOne(person());
    const permissions = ["reports.view", "customers.view"];
    const result = await list({}, { permissions });
    expect(result.data[0]).toMatchObject({
      paidSpendMinor: null,
      currentCreditMinor: null,
      cancelledBookings: null,
      inactiveDays: null,
    });
    expect(result.suggested.inactive90DaysWithCredits).toBeNull();
    for (const input of [
      { spendMin: 0 },
      { creditMax: 0 },
      { cancelledMax: 0 },
      { inactiveDays: 90 },
    ])
      await expect(list(input, { permissions })).rejects.toThrow();
    const incompleteFinance = ALL_WORKSPACE_PERMISSIONS.filter(
      (value) => value !== "memberships.view",
    );
    const incomplete = await list({}, { permissions: incompleteFinance });
    expect(incomplete.metadata.spendingAvailable).toBe(false);
    expect(incomplete.data[0].paidSpendMinor).toBeNull();
    await expect(
      list({ spendMax: 0 }, { permissions: incompleteFinance }),
    ).rejects.toThrow();
    const scoped = await list(
      { locationId: String(location) },
      { permissions: incompleteFinance },
    );
    expect(scoped.metadata).toMatchObject({
      spendingAvailable: true,
      spendingScope: "location",
    });
    expect(scoped.metadata.limitations.length).toBeGreaterThan(0);
  });
  it("uses current canonical wallet and last started confirmed visit for inactive suggestions, not future bookings", async () => {
    const old = person({ moneyCredits: 999, moneyCreditsMinor: 2500 });
    const recent = person(),
      newCustomer = person({ createdAt: new Date("2026-11-01T12:00:00Z") });
    await User.collection.insertMany([old, recent, newCustomer]);
    await Booking.collection.insertMany([
      booking(old._id, { status: "processed" }),
      booking(recent._id, {
        status: "processed",
        start: new Date("2026-11-10T12:00:00Z"),
        end: new Date("2026-11-10T13:00:00Z"),
      }),
    ]);
    const result = await list({ inactiveDays: 90, creditMin: 0.01 });
    expect(result.data.map((row) => row.id)).toEqual([String(old._id)]);
    expect(result.data[0].currentCreditMinor).toBe(2500);
    expect(result.suggested.inactive90DaysWithCredits).toBe(1);
    await User.collection.insertOne(
      person({ moneyCredits: null, moneyCreditsMinor: null }),
    );
    expect((await list()).suggested.inactive90DaysWithCredits).toBeNull();
  });
  it("does not represent malformed historical class operation dates as zero cancellations", async () => {
    const user = person();
    await User.collection.insertOne(user);
    const session = booking(actor, { tag: "course", status: "processed" });
    await Booking.collection.insertOne(session);
    await Order.collection.insertOne(
      order(user._id, {
        courseCancellations: [{ bookingId: session._id, quantity: 1, actor }],
      }),
    );
    expect((await list()).data[0]).toMatchObject({
      cancelledBookings: null,
      recordedCancelledBookings: 0,
      cancellationHistoryComplete: false,
    });
    expect((await list({ cancelledMax: 0 })).data).toHaveLength(0);
  });
  it("rejects malformed/reversed amounts, unsafe precision, untrusted scope fields and oversized independent periods", async () => {
    for (const input of [
      { spendMin: "" },
      { creditMin: null },
      { cancelledMin: -1 },
      { cancelledMin: 1.5 },
      { spendMin: 20, spendMax: 10 },
      { creditMin: 0.001 },
      { tenantId: String(foreignTenant) },
      { cancellationFrom: "2025-01-01", cancellationTo: "2026-11-01" },
      { spendFrom: "2026-02-30" },
    ])
      await expect(list(input)).rejects.toThrow();
  });
});
