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
import {
  getMyBooking,
  listMyBookings,
} from "@/modules/booking/booking.customer.service.js";
import Order from "@/modules/order/order.model.js";
import { getMyOrderConfirmation } from "@/modules/order/order.customer.service.js";
import User from "@/modules/user/user.model.js";
import Location from "@/modules/location/location.model.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const locationId = new mongoose.Types.ObjectId();
const otherLocationId = new mongoose.Types.ObjectId();
const now = new Date("2026-10-22T08:00:00Z");
const expiredAt = new Date("2026-10-12T08:29:17Z");

const booking = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant: tenantId,
  createdBy: userId,
  location: locationId,
  tag: "open-studio",
  status: "processed",
  paymentStatus: "CONFIRMED",
  numberOfGuests: 1,
  start: new Date("2026-10-30T05:00:00Z"),
  end: new Date("2026-10-30T06:00:00Z"),
  ...overrides,
});
const order = (
  bookingId: mongoose.Types.ObjectId,
  overrides: Record<string, unknown> = {},
) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant: tenantId,
  createdBy: userId,
  workshopBookings: [bookingId],
  isPaid: true,
  status: "processed_order",
  ...overrides,
});
const list = (input: Partial<Parameters<typeof listMyBookings>[0]> = {}) =>
  listMyBookings({
    tenantId: String(tenantId),
    userId: String(userId),
    ...input,
  });
const ids = (result: Awaited<ReturnType<typeof list>>) =>
  result.bookings.map((row) => row.id).sort();

describe("customer booking history classifies reservation state before pagination", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(async () => {
    await clearTestDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await User.collection.insertOne({
      _id: userId,
      tenant: tenantId,
      tenantRole: "customer",
      platformRole: "none",
      isAccessGranted: true,
    });
    await Location.collection.insertMany([
      {
        _id: locationId,
        tenant: tenantId,
        name: "Grohova",
        slug: "grohova",
        code: "GRO",
      },
      {
        _id: otherLocationId,
        tenant: tenantId,
        name: "Other",
        slug: "other",
        code: "OTHER",
      },
    ]);
  });

  it("puts an abandoned hold and the separately paid cancelled visit in History", async () => {
    const abandoned = booking({
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
    });
    const cancelled = booking({ status: "cancelled" });
    const confirmed = booking({
      start: new Date("2026-10-31T05:00:00Z"),
      end: new Date("2026-10-31T06:00:00Z"),
    });
    await Booking.collection.insertMany([abandoned, cancelled, confirmed]);
    await Order.collection.insertMany([
      order(abandoned._id, { isPaid: false, status: "pending_order" }),
      order(cancelled._id),
      order(confirmed._id),
    ]);

    expect(ids(await list())).toEqual([String(confirmed._id)]);
    const history = await list({ scope: "history" });
    expect(ids(history)).toEqual(
      [String(abandoned._id), String(cancelled._id)].sort(),
    );
    expect(
      history.bookings.find((row) => row.id === String(abandoned._id)),
    ).toMatchObject({
      reservationState: "expired",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
      isActiveReservation: false,
    });
    expect(
      history.bookings.find((row) => row.id === String(cancelled._id)),
    ).toMatchObject({
      reservationState: "cancelled",
      paymentStatus: "CONFIRMED",
      isActiveReservation: false,
    });
    expect((await list({ scope: "all" })).totalCount).toBe(3);
  });

  it("keeps paid unfulfilled orders discoverable without granting an active reservation", async () => {
    const unfulfilled = booking({
      status: "pending",
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
    });
    await Booking.collection.insertOne(unfulfilled);
    const paidOrder = order(unfulfilled._id, { status: "pending_order" });
    await Order.collection.insertOne(paidOrder);
    const upcoming = await list();
    expect(upcoming.totalCount).toBe(1);
    expect(upcoming.bookings[0]).toMatchObject({
      reservationState: "awaiting_confirmation",
      isActiveReservation: false,
    });
    expect((await list({ scope: "history" })).totalCount).toBe(0);
    const detail = await getMyBooking({
      tenantId: String(tenantId),
      userId: String(userId),
      bookingId: String(unfulfilled._id),
    });
    expect(detail).toMatchObject({
      reservationState: "awaiting_confirmation",
      isActiveReservation: false,
    });
    expect(detail).not.toHaveProperty("createdBy");
    expect(detail).not.toHaveProperty("orderId");
    const confirmation = await getMyOrderConfirmation({
      tenantId: String(tenantId),
      userId: String(userId),
      orderId: String(paidOrder._id),
    });
    expect(confirmation.bookings[0]).toMatchObject({
      reservationState: "awaiting_confirmation",
      isActiveReservation: false,
      paymentExpiresAt: expiredAt,
    });
  });

  it("does not let another tenant or customer's paid order revive an unpaid hold", async () => {
    const wrongTenant = booking({
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
    });
    const wrongOwner = booking({
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
    });
    await Booking.collection.insertMany([wrongTenant, wrongOwner]);
    await Order.collection.insertMany([
      order(wrongTenant._id, { tenant: otherTenantId }),
      order(wrongOwner._id, { createdBy: otherUserId }),
    ]);
    expect((await list()).totalCount).toBe(0);
    expect((await list({ scope: "history" })).totalCount).toBe(2);
  });

  it("filters before skip/limit/count and retains tenant, owner and location boundaries", async () => {
    const visible = [0, 1, 2].map((index) =>
      booking({
        start: new Date(`2026-10-${28 + index}T05:00:00Z`),
        end: new Date(`2026-10-${28 + index}T06:00:00Z`),
      }),
    );
    await Booking.collection.insertMany([
      ...visible,
      booking({
        start: new Date("2026-10-27T05:00:00Z"),
        paymentStatus: "EXPIRED",
      }),
      booking({ tenant: otherTenantId }),
      booking({ createdBy: otherUserId }),
      booking({ location: otherLocationId }),
    ]);
    const first = await list({ locationId: String(locationId), limit: 2 });
    const second = await list({
      locationId: String(locationId),
      limit: 2,
      page: 2,
    });
    expect(first).toMatchObject({
      totalCount: 3,
      totalPages: 2,
      currentPage: 1,
    });
    expect(first.bookings.map((row) => row.id)).toEqual(
      visible.slice(0, 2).map((row) => String(row._id)),
    );
    expect(second).toMatchObject({
      totalCount: 3,
      totalPages: 2,
      currentPage: 2,
    });
    expect(ids(second)).toEqual([String(visible[2]._id)]);
    expect(
      (await list({ locationId: String(locationId), scope: "history" }))
        .totalCount,
    ).toBe(1);
  });

  it("keeps live holds and legacy bookings while selecting Classes through paid processed orders", async () => {
    const hold = booking({
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: new Date(now.getTime() + 60_000),
    });
    const legacy = booking({ paymentStatus: undefined });
    const paidClass = booking({
      tag: "class",
      createdBy: otherUserId,
      paymentStatus: "PENDING_PAYMENT",
      paymentExpiresAt: expiredAt,
    });
    const unpaidClass = booking({ tag: "course", createdBy: otherUserId });
    const completed = booking({ status: "completed" });
    const noDeadline = booking({ paymentStatus: "PENDING_PAYMENT" });
    const failed = booking({ paymentStatus: "FAILED" });
    await Booking.collection.insertMany([
      hold,
      legacy,
      paidClass,
      unpaidClass,
      completed,
      noDeadline,
      failed,
    ]);
    await Order.collection.insertMany([
      order(paidClass._id, {
        workshopBookings: [],
        courseBookings: [{ bookingId: paidClass._id, quantity: 2 }],
      }),
      order(unpaidClass._id, {
        workshopBookings: [],
        isPaid: false,
        courseBookings: [{ bookingId: unpaidClass._id, quantity: 1 }],
      }),
    ]);
    const upcoming = await list();
    expect(ids(upcoming)).toEqual(
      [hold, legacy, paidClass].map((row) => String(row._id)).sort(),
    );
    expect(
      upcoming.bookings.find((row) => row.id === String(hold._id)),
    ).toMatchObject({
      reservationState: "awaiting_payment",
      isActiveReservation: true,
    });
    expect(
      upcoming.bookings.find((row) => row.id === String(paidClass._id)),
    ).toMatchObject({
      reservationState: "confirmed",
      paymentStatus: "CONFIRMED",
      participantCount: 2,
    });
    expect(ids(await list({ scope: "history" }))).toEqual(
      [completed, noDeadline, failed].map((row) => String(row._id)).sort(),
    );
  });

  it("keeps an ongoing delivered three-hour visit upcoming until it ends", async () => {
    const ongoing = booking({
      status: "delivered",
      start: new Date(now.getTime() - 2 * 3_600_000),
      end: new Date(now.getTime() + 3_600_000),
    });
    const past = booking({
      status: "delivered",
      start: new Date(now.getTime() - 5 * 3_600_000),
      end: new Date(now.getTime() - 2 * 3_600_000),
    });
    await Booking.collection.insertMany([ongoing, past]);
    const upcoming = await list();
    expect(ids(upcoming)).toEqual([String(ongoing._id)]);
    expect(upcoming.bookings[0]).toMatchObject({
      reservationState: "confirmed",
      isActiveReservation: true,
    });
    const history = await list({ scope: "history" });
    expect(ids(history)).toEqual([String(past._id)]);
    expect(history.bookings[0]).toMatchObject({
      reservationState: "completed",
      isActiveReservation: false,
    });
  });
});
