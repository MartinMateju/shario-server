import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Tenant from "@/modules/tenants/tenant.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import Order from "@/modules/order/order.model.js";
import UserMembership from "@/modules/membership/user-membership.model.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { buildDashboardManagement } from "@/modules/dashboard/dashboard-management.service.js";
import { getCustomerMembershipSummary } from "@/modules/user/services/user.membership-summary.service.js";
import { createPlatformBypassAccess } from "@/modules/tenant-access/services/authorization.service.js";
import { clearTestDatabase, connectTestDatabase, disconnectTestDatabase } from "../../helpers/mongoMemory.js";

const oid = () => new mongoose.Types.ObjectId();
const tenant = oid(), foreignTenant = oid(), studio = oid(), otherStudio = oid();
const first = oid(), second = oid(), third = oid(), product = oid(), otherProduct = oid();
const now = new Date("2026-11-16T12:00:00Z");
const paidAt = new Date("2026-11-06T12:00:00Z");
const owner = createPlatformBypassAccess({ tenantId: String(tenant), userId: String(oid()) });
const snapshot = (access = owner, locationId = studio) => buildDashboardManagement({
  context: { tenantId: String(tenant), userId: owner.userId, access },
  query: { date: "2026-11-16", locationId: String(locationId) }, now,
});
const refund = (amount: number, status = "partial") => ({
  status, succeededAmountMinor: amount, pendingAmountMinor: 0, reviewRequired: false,
});
const order = (overrides: Record<string, unknown> = {}) => ({
  _id: oid(), tenant, createdBy: first, isPaid: true, status: "processed_order",
  currency: "CZK", paidAmountMinor: 10000, paidAt, createdAt: paidAt,
  locationIds: [studio],
  lineItems: [{ product, description: "Clay", quantity: 2, locationIds: [studio], grossAmountMinor: 10000 }],
  ...overrides,
});
const insertOrders = (rows: ReturnType<typeof order>[]) => Order.collection.insertMany(rows as any[]);
const member = (overrides: Record<string, unknown> = {}) => ({
  _id: oid(), tenant, user: first, status: "active", selectedLocation: studio,
  planSnapshot: { name: "Studio", locationScope: { type: "selected", locationIds: [studio] } },
  startedAt: new Date("2026-11-01"), currentPeriodStart: new Date("2026-11-01"), currentPeriodEnd: new Date("2026-12-01"),
  ...overrides,
});

beforeAll(async () => {
  await connectTestDatabase();
  // Exercise fixtures against the production unique indexes, not index-build timing.
  await Promise.all([
    Tenant.init(), Location.init(), User.init(), Order.init(),
    UserMembership.init(), MembershipInvoice.init(), CouponOrder.init(),
  ]);
});
afterAll(disconnectTestDatabase);
beforeEach(async () => {
  await clearTestDatabase();
  await Tenant.collection.insertOne({
    _id: tenant, slug: "dashboard-commerce", plan: "professional", planVersion: 3,
    modules: { bookings: true, payments: true, customers: true, courses: true, memberships: true, vouchers: true },
    settings: { currency: "CZK", timezone: "Europe/Prague" },
  } as any);
  await Location.collection.insertMany([
    { _id: studio, tenant, slug: "studio-a", code: "STUDIO-A" },
    { _id: otherStudio, tenant, slug: "studio-b", code: "STUDIO-B" },
  ] as any[]);
  await User.collection.insertMany([first, second, third].map((_id, index) => ({
    _id, tenant, tenantRole: "customer", platformRole: "none", createdAt: new Date("2025-01-01"),
    firstname: `Customer ${index + 1}`, customId: `customer-${index + 1}`, memberNumber: index + 101,
  })) as any[]);
});

describe("dashboard commerce against real Mongo queries", () => {
  it("counts shared-selected subscribers at each entitled studio and matches the scoped directory", async () => {
    const outsideStudio = oid();
    const sharedPlan = { name: "Shared studios", locationScope: { type: "shared_selected", locationIds: [studio, otherStudio] } };
    await UserMembership.collection.insertMany([
      member({ selectedLocation: null, planSnapshot: sharedPlan }), member(),
      member({ user: second, status: "cancel_scheduled", selectedLocation: null, planSnapshot: sharedPlan }),
      member({ user: third, selectedLocation: otherStudio,
        planSnapshot: { name: "Choose one", locationScope: { type: "selected", locationIds: [studio, otherStudio] } } }),
      member({ user: oid(), selectedLocation: null,
        planSnapshot: { name: "Outside", locationScope: { type: "shared_selected", locationIds: [outsideStudio] } } }),
      member({ user: oid(), tenant: foreignTenant, selectedLocation: null, planSnapshot: sharedPlan }),
      member({ user: oid(), currentPeriodEnd: now, selectedLocation: null, planSnapshot: sharedPlan }),
    ] as any[]);
    const access = { ...owner, locationAccess: { mode: "selected" as const, locationIds: [String(studio)] } };
    expect((await snapshot()).summary.activeMemberships.value).toBe(2);
    expect((await snapshot(owner, otherStudio)).summary.activeMemberships.value).toBe(3);
    const restrictedDashboard = await snapshot(access);
    const directory = await getCustomerMembershipSummary({ tenantId: String(tenant), now, access });
    expect(restrictedDashboard.summary.activeMemberships.value).toBe(2);
    expect(directory.activeMemberships).toBe(restrictedDashboard.summary.activeMemberships.value);
  });

  it("returns workspace net receipts and paying customers without visits, while subscribers follow studio entitlement", async () => {
    await insertOrders([
      order(),
      order({ createdBy: second, locationIds: [otherStudio], paidAmountMinor: 7000, refund: refund(1000) }),
      order({ createdBy: null, paidAmountMinor: 3000 }),
      order({ tenant: foreignTenant, paidAmountMinor: 99999 }),
    ]);
    await CouponOrder.collection.insertOne({ tenant, createdBy: first, paidAt, status: "processed_coupon", currencySnapshot: "CZK", expectedAmountMinor: 5000 } as any);
    await MembershipInvoice.collection.insertOne({ tenant, user: first, paidAt, currency: "CZK", amountPaidMinor: 4000, refund: refund(1000) } as any);
    await UserMembership.collection.insertMany([
      member({ selectedLocation: null, planSnapshot: { name: "Shared", locationScope: { type: "all" } } }),
      member(), member({ user: second, status: "cancel_scheduled" }),
      member({ user: third, selectedLocation: otherStudio }), member({ tenant: foreignTenant, user: oid() }),
    ] as any[]);
    const result = await snapshot();
    expect(result.summary.recordedPaymentsMinor?.value).toBe(27000);
    expect(result.summary.recordedPaymentsComplete).toBe(true);
    expect(result.metadata.revenueScope).toBe("workspace");
    expect(result.topClients.byVisits).toEqual([]);
    expect(result.topClients.byRevenue.map(row => [row.id, row.spentMonthMinor, row.spentTotalMinor, row.memberNumber])).toEqual([
      [String(first), 18000, 18000, 101], [String(second), 6000, 6000, 102],
    ]);
    expect(result.summary.activeMemberships.value).toBe(2);
    const directory = await getCustomerMembershipSummary({ tenantId: String(tenant), now,
      access: { ...owner, locationAccess: { mode: "selected", locationIds: [String(studio)] } },
    });
    expect(directory.activeMemberships).toBe(result.summary.activeMemberships.value);
  });

  it("counts last-30-day paid purchases across Prague DST without completion records", async () => {
    const boundary = new Date("2026-10-17T22:00:00Z"); // 18 October midnight Prague
    await insertOrders([
      order({ paidAt: boundary }), order({ paidAt: new Date("2026-10-25T00:30:00Z") }),
      order({ paidAt: new Date("2026-10-25T01:30:00Z") }),
      order({ paidAt: new Date(boundary.valueOf() - 1) }),
      order({ paidAmountMinor: 500, lineItems: [
        { product: otherProduct, description: "Glaze", quantity: 2, locationIds: [studio] },
        { product: otherProduct, description: "Glaze", quantity: 1, locationIds: [studio] },
      ] }),
      order({ isPaid: false }), order({ paidAt: now }),
      order({ refund: refund(10000, "full") }),
      order({ tenant: foreignTenant }),
      order({ locationIds: [otherStudio], paidAmountMinor: 900,
        lineItems: [{ product, description: "Clay", quantity: 2, locationIds: [otherStudio] }] }),
    ]);
    const result = await snapshot();
    expect(result.topProducts).toMatchObject({ available: true, complete: true, scope: "workspace", basis: "paid_purchases", period: { from: "2026-10-18", to: "2026-11-16" } });
    expect(result.topProducts.items.map(row => [row.id, row.purchaseCount, row.quantity])).toEqual([
      [String(product), 4, 8], [String(otherProduct), 1, 3],
    ]);
    expect(result.summary.recordedPaymentsMinor?.value).toBe(1400);
    expect(result.metadata.period.from).toBe("2026-11-01");
    const restricted = await snapshot({ ...owner, locationAccess: { mode: "selected", locationIds: [String(studio)] } });
    expect(restricted.topProducts.scope).toBe("selected_locations");
    expect(restricted.topProducts.items.map(row => [row.id, row.purchaseCount])).toEqual([
      [String(product), 3], [String(otherProduct), 1],
    ]);
  });

  it("includes standalone voucher Product purchases with snapshot names and excludes unpaid or refunded vouchers", async () => {
    const voucherProduct = oid();
    const voucher = (overrides: Record<string, unknown> = {}) => ({
      _id: oid(), tenant, createdBy: first, paidAt, status: "processed_coupon",
      product: voucherProduct, productNameSnapshot: "Gift voucher", quantity: 3,
      currencySnapshot: "CZK", expectedAmountMinor: 6000, refundedAmountMinor: 0,
      ...overrides,
    });
    await CouponOrder.collection.insertMany([
      voucher(), voucher({ status: "shipped_coupon", quantity: 1, paidAt: new Date("2026-10-17T22:00:00Z") }),
      voucher({ status: "pending_coupon_payment", paidAt: null }),
      voucher({ refundedAmountMinor: 6000, refundState: "revoked" }),
      voucher({ tenant: foreignTenant }), voucher({ paidAt: now }),
      voucher({ paidAt: new Date("2026-10-17T21:59:59.999Z") }),
    ] as any[]);
    const result = await snapshot();
    expect(result.topProducts).toMatchObject({ available: true, complete: true, scope: "workspace" });
    expect(result.topProducts.items).toEqual([
      expect.objectContaining({ id: String(voucherProduct), name: "Gift voucher", purchaseCount: 2, quantity: 4 }),
    ]);
    expect(result.summary.recordedPaymentsMinor?.value).toBe(6000);
    const restricted = await snapshot({ ...owner, locationAccess: { mode: "selected", locationIds: [String(studio)] } });
    expect(restricted.topProducts).toMatchObject({ available: true, complete: false, scope: "selected_locations", items: [] });
  });

  it("keeps a known subtotal and purchase rows when legacy payment dates are missing", async () => {
    await insertOrders([order(), order({ paidAt: null, paidAmountMinor: 2500 })]);
    const result = await snapshot();
    expect(result.summary.recordedPaymentsMinor?.value).toBe(10000);
    expect(result.summary.recordedPaymentsComplete).toBe(false);
    expect(result.summary.recordedPaymentsMinor?.changePercent).toBeNull();
    expect(result.topClients.byRevenue[0]).toMatchObject({ spentMonthMinor: 10000, spentMonthComplete: false });
    expect(result.topProducts).toMatchObject({ available: true, complete: false });
    expect(result.topProducts.items[0].purchaseCount).toBe(1);
  });

  it("makes financial data unavailable when denied without tying payment ranking to booking permission", async () => {
    await insertOrders([order()]);
    const denied = await snapshot({ ...owner, permissions: owner.permissions.filter(permission => permission !== "payments.view") });
    expect(denied.summary.recordedPaymentsMinor?.value).toBeNull();
    expect(denied.topClients.revenueAvailable).toBe(false);
    expect(denied.topClients.byRevenue).toEqual([]);
    expect(denied.topProducts.available).toBe(false);
    const noBookings = await snapshot({ ...owner, permissions: owner.permissions.filter(permission => permission !== "bookings.view") });
    expect(noBookings.topClients.available).toBe(true);
    expect(noBookings.topClients.byRevenue[0].spentMonthMinor).toBe(10000);
  });
});
