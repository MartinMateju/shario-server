import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import Order from "@/modules/order/order.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import { withCustomerDirectoryMetrics } from "@/modules/user/services/user.directory-metrics.service.js";
import {
  listUsers,
  listUsersWithFilters,
} from "@/modules/user/services/user.read.service.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const foreignTenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const secondCustomer = new mongoose.Types.ObjectId();
const emptyCustomer = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const otherLocation = new mongoose.Types.ObjectId();
const now = new Date("2026-10-31T12:00:00Z");
const users = [customer, secondCustomer, emptyCustomer].map((_id) => ({ _id }));
const access = (overrides: Record<string, unknown> = {}) =>
  ({
    tenantId: String(tenant),
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
    ...overrides,
  }) as ResolvedWorkspaceAccess;
const metrics = (
  input: Partial<Parameters<typeof withCustomerDirectoryMetrics>[0]> = {},
) =>
  withCustomerDirectoryMetrics({
    tenantId: String(tenant),
    users,
    access: access(),
    now,
    ...input,
  });
const booking = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  location,
  createdBy: customer,
  tag: "open-studio",
  status: "processed",
  paymentStatus: "CONFIRMED",
  start: new Date("2026-10-01T10:00:00Z"),
  end: new Date("2026-10-01T12:00:00Z"),
  ...overrides,
});
const order = (overrides: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  createdBy: customer,
  isPaid: true,
  status: "processed_order",
  currency: "CZK",
  paidAmountMinor: 10000,
  locationIds: [location],
  ...overrides,
});

describe("customer directory metrics from recorded bookings and payments", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(async () => {
    await clearTestDatabase();
    await Tenant.collection.insertOne({
      _id: tenant,
      settings: { currency: "EUR" },
    });
  });

  it("uses the latest started confirmed visit, including ongoing visits, not future/draft/cancelled rows", async () => {
    await Booking.collection.insertMany([
      booking(),
      booking({
        start: new Date("2026-10-31T11:00:00Z"),
        end: new Date("2026-10-31T13:00:00Z"),
        status: "delivered",
      }),
      booking({
        start: new Date("2026-11-10T10:00:00Z"),
        end: new Date("2026-11-10T12:00:00Z"),
      }),
      ...["cancelled", "pending"].map((status) =>
        booking({ status, start: new Date("2026-10-31T11:30:00Z"), end: now }),
      ),
      booking({
        paymentStatus: "FAILED",
        start: new Date("2026-10-31T11:30:00Z"),
        end: now,
      }),
      booking({
        tenant: foreignTenant,
        start: new Date("2026-10-31T11:30:00Z"),
        end: now,
      }),
      booking({ start: "2026-10-31T11:30:00Z", end: now }),
      booking({
        start: new Date("2026-10-31T11:30:00Z"),
        end: new Date("2026-10-30T10:00:00Z"),
      }),
    ]);
    const result = await metrics();
    expect(result[0].lastBookingAt).toBe("2026-10-31T11:00:00.000Z");
    expect(result[1].lastBookingAt).toBeNull();
  });

  it("links class customers through paid orders and excludes their cancelled places", async () => {
    const attended = booking({ tag: "class", createdBy: secondCustomer });
    const cancelledPlace = booking({
      tag: "course",
      createdBy: secondCustomer,
      start: new Date("2026-10-30T10:00:00Z"),
      end: new Date("2026-10-30T12:00:00Z"),
    });
    await Booking.collection.insertMany([attended, cancelledPlace]);
    await Order.collection.insertMany([
      order({ courseBookings: [{ bookingId: attended._id, quantity: 1 }] }),
      order({
        courseBookings: [{ bookingId: cancelledPlace._id, quantity: 2 }],
        courseCancellations: [{ bookingId: cancelledPlace._id, quantity: 2 }],
      }),
      order({
        createdBy: emptyCustomer,
        isPaid: false,
        courseBookings: [{ bookingId: cancelledPlace._id, quantity: 1 }],
      }),
    ]);
    const result = await metrics();
    expect(result[0].lastBookingAt).toBe(attended.start.toISOString());
    expect(result[1].lastBookingAt).toBeNull(); // Class creator is not an attendee.
    expect(result[2].lastBookingAt).toBeNull();
  });

  it("sums captured cash once, including topups and paid failed/cancelled fulfillment, less successful cash refunds", async () => {
    const refunded = order({ paidAmountMinor: 8000 });
    await Order.collection.insertMany([
      order(),
      order({ creditPurchase: { amount: 200 }, paidAmountMinor: 20000 }),
      order({
        paidAmountMinor: 0,
        paymentAllocations: [{ method: "credits", amountMinor: 20000 }],
      }),
      order({ status: "failed_order", paidAmountMinor: 5000 }),
      order({
        status: "cancelled_order",
        waitlistRefund: { status: "succeeded", amountMinor: 10000 },
      }),
      order({
        paidAmountMinor: 4000,
        pieceCheckout: { refundedAmountMinor: 1000 },
      }),
      { ...refunded, courseCancellations: [{ refundAmountMinor: 8000 }] },
      order({ isPaid: false, paidAmountMinor: 999999 }),
      order({ tenant: foreignTenant, paidAmountMinor: 999999 }),
    ]);
    await BookingPaymentRefund.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        order: refunded._id,
        customer,
        currency: "CZK",
        status: "succeeded",
        cardAmountMinor: 2000,
        amountMinor: 4000,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant,
        order: refunded._id,
        customer,
        currency: "CZK",
        status: "provider_pending",
        cardAmountMinor: 6000,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        tenant: foreignTenant,
        order: refunded._id,
        customer,
        currency: "CZK",
        status: "succeeded",
        cardAmountMinor: 6000,
      },
    ]);
    await CouponOrder.collection.insertMany([
      {
        tenant,
        createdBy: customer,
        paidAt: now,
        currencySnapshot: "CZK",
        expectedAmountMinor: 3000,
        refundedAmountMinor: 500,
        status: "pending_coupon_payment",
      },
      {
        tenant,
        createdBy: null,
        paidAt: now,
        currencySnapshot: "CZK",
        expectedAmountMinor: 999999,
      },
    ]);
    await MembershipInvoice.collection.insertMany([
      {
        tenant,
        user: customer,
        connectedAccountId: "fixture-account",
        stripeInvoiceId: "fixture-paid",
        paidAt: now,
        status: "paid",
        currency: "CZK",
        amountPaidMinor: 8000,
      },
      {
        tenant,
        user: customer,
        connectedAccountId: "fixture-account",
        stripeInvoiceId: "fixture-partial",
        paidAt: null,
        status: "open",
        currency: "CZK",
        amountPaidMinor: 500,
      },
      {
        tenant,
        user: customer,
        connectedAccountId: "fixture-account",
        stripeInvoiceId: "fixture-unpaid",
        paidAt: null,
        status: "open",
        currency: "CZK",
        amountPaidMinor: 0,
      },
    ]);
    const result = await metrics();
    expect(result[0]).toMatchObject({
      totalSpent: 550,
      totalSpentCurrency: "CZK",
      totalSpentByCurrency: [{ currency: "CZK", amountMinor: 55000 }],
    });
    expect(result[2]).toMatchObject({
      totalSpent: null,
      totalSpentCurrency: "EUR",
      totalSpentByCurrency: [],
    });
    await Tenant.collection.updateOne(
      { _id: tenant },
      { $set: { "settings.currency": "CZK" } },
    );
    const [emptyCzk] = await metrics({ users: [{ _id: emptyCustomer }] });
    expect(emptyCzk).toMatchObject({
      totalSpent: 0,
      totalSpentCurrency: "CZK",
      totalSpentByCurrency: [],
    });
  });

  it("keeps currencies separate and respects zero-decimal currency units", async () => {
    await Order.collection.insertMany([
      order({ currency: "CZK", paidAmountMinor: 12345 }),
      order({ currency: "EUR", paidAmountMinor: 600 }),
      order({
        createdBy: secondCustomer,
        currency: "JPY",
        paidAmountMinor: 120,
      }),
      order({
        createdBy: emptyCustomer,
        currency: "EUR",
        paidAmountMinor: 600,
      }),
    ]);
    const result = await metrics();
    expect(result[0]).toMatchObject({
      totalSpent: null,
      totalSpentCurrency: null,
      totalSpentByCurrency: [
        { currency: "CZK", amountMinor: 12345 },
        { currency: "EUR", amountMinor: 600 },
      ],
    });
    expect(result[1]).toMatchObject({
      totalSpent: null,
      totalSpentCurrency: "JPY",
      totalSpentByCurrency: [{ currency: "JPY", amountMinor: 120 }],
    });
    expect(result[2]).toMatchObject({
      totalSpent: null,
      totalSpentCurrency: "EUR",
      totalSpentByCurrency: [{ currency: "EUR", amountMinor: 600 }],
    });
  });

  it("returns unknown for missing monetary evidence or a failed refund requiring review", async () => {
    await Order.collection.insertMany([
      order(),
      order({ paidAmountMinor: null }),
      order({ createdBy: secondCustomer, currency: null }),
    ]);
    await CouponOrder.collection.insertOne({
      tenant,
      createdBy: emptyCustomer,
      paidAt: now,
      currencySnapshot: "CZK",
      expectedAmountMinor: 1000,
      refundedAmountMinor: 500,
      refundFailureReviewRequired: true,
    });
    for (const row of await metrics()) {
      expect(row.totalSpent).toBeNull();
      expect(row.totalSpentByCurrency).toBeNull();
    }
  });

  it("does not expose metrics without each required permission or with another tenant's access", async () => {
    await Booking.collection.insertOne(booking());
    await Order.collection.insertOne(order());
    for (const missing of [
      "orders.view",
      "payments.view",
      "vouchers.view",
      "memberships.view",
    ]) {
      const [result] = await metrics({
        access: access({
          permissions: ALL_WORKSPACE_PERMISSIONS.filter(
            (value) => value !== missing,
          ),
        }),
      });
      expect(result.lastBookingAt).not.toBeNull();
      expect(result.totalSpentByCurrency).toBeNull();
    }
    const [bookingsHidden] = await metrics({
      access: access({
        permissions: ALL_WORKSPACE_PERMISSIONS.filter(
          (value) => value !== "bookings.view",
        ),
      }),
    });
    expect(bookingsHidden.lastBookingAt).toBeNull();
    expect(bookingsHidden.totalSpent).toBe(100);
    for (const untrusted of [
      undefined,
      access({ tenantId: String(foreignTenant) }),
    ]) {
      const [result] = await metrics({ access: untrusted });
      expect(result.lastBookingAt).toBeNull();
      expect(result.totalSpentByCurrency).toBeNull();
    }
  });

  it("limits booking dates to allowed locations and withholds partial lifetime spending", async () => {
    await Booking.collection.insertMany([
      booking(),
      booking({
        location: otherLocation,
        start: new Date("2026-10-30T10:00:00Z"),
        end: new Date("2026-10-30T12:00:00Z"),
      }),
    ]);
    await Order.collection.insertOne(
      order({ locationIds: [location, otherLocation] }),
    );
    const [result] = await metrics({
      access: access({
        locationAccess: { mode: "selected", locationIds: [String(location)] },
      }),
    });
    expect(result.lastBookingAt).toBe("2026-10-01T10:00:00.000Z");
    expect(result.totalSpentByCurrency).toBeNull();
  });

  it("enriches both directory APIs after pagination without changing counts or customer filters", async () => {
    await User.collection.insertMany(
      users.map((user, index) => ({
        ...user,
        tenant,
        tenantRole: "customer",
        platformRole: "none",
        memberNumber: index + 1,
        customId: `member-${index + 1}`,
        firstname: "Fixture",
        lastname: String(index),
        createdAt: new Date(now.getTime() + index),
      })),
    );
    await Order.collection.insertOne(order());
    const list = await listUsers({
      tenantId: String(tenant),
      tenantRole: "customer",
      access: access(),
    });
    expect(
      list.find((row) => String(row._id) === String(customer))?.totalSpent,
    ).toBe(100);
    const page = await listUsersWithFilters({
      tenantId: String(tenant),
      access: access(),
      input: { tenantRole: "customer", limit: 1, page: 3 },
    });
    expect(page).toMatchObject({
      totalCount: 3,
      totalPages: 3,
      currentPage: 3,
      pageSize: 1,
    });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      totalSpent: 100,
      totalSpentCurrency: "CZK",
    });
  });
});
