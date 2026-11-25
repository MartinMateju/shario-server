import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  scope: vi.fn(),
  entitlement: vi.fn(),
  booking: vi.fn(),
  order: vi.fn(),
  customOrder: vi.fn(),
  membership: vi.fn(),
  refund: vi.fn(),
  coupon: vi.fn(),
  ledger: vi.fn(),
  email: vi.fn(),
  invoice: vi.fn(),
  nativeInvoicing: vi.fn(),
  customerDetails: vi.fn(),
  spendingRanking: vi.fn(),
  user: vi.fn(),
}));
vi.mock("@/modules/dashboard/dashboard-management.customers.js", () => ({
  getManagementCustomerDetails: mocks.customerDetails,
  getManagementSpendingRanking: mocks.spendingRanking,
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.tenant },
}));
vi.mock("@/modules/reports/reports.scope.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/reports/reports.scope.js")>(),
  resolveReportLocationScope: mocks.scope,
}));
vi.mock("@/modules/reports/report-plan-entitlements.js", () => ({
  getReportPlanEntitlement: mocks.entitlement,
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  hasWorkspacePermission: (access: any, permission: string) =>
    access.permissions.includes(permission),
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.booking },
}));
vi.mock("@/modules/user/user.model.js", () => ({
  default: { find: mocks.user },
}));
vi.mock("@/modules/order/order.model.js", () => ({
  default: { find: mocks.order },
}));
vi.mock("@/modules/custom-orders/custom-order.model.js", () => ({
  CustomOrder: { find: mocks.customOrder },
}));
vi.mock("@/modules/membership/user-membership.model.js", () => ({
  default: { find: mocks.membership },
}));
vi.mock("@/modules/booking/booking-payment-refund.model.js", () => ({
  BookingPaymentRefund: { find: mocks.refund },
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { find: mocks.coupon },
}));
vi.mock("@/modules/coupon/voucher-ledger.model.js", () => ({
  VoucherLedger: { find: mocks.ledger },
}));
vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({ default: { find: mocks.email } }),
);
vi.mock("@/modules/invoice/invoice.schema.js", () => ({
  InvoiceModel: { find: mocks.invoice },
}));
vi.mock("@/modules/invoice/invoice.feature.js", () => ({
  isNativeInvoicingEnabled: mocks.nativeInvoicing,
}));

import { buildDashboardManagement } from "@/modules/dashboard/dashboard-management.service.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";
const chain = (rows: any) => {
  const query = {
    select: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  query.select.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
};
const context = (permissions: readonly string[] = ALL_WORKSPACE_PERMISSIONS) =>
  ({
    tenantId: "tenant-a",
    userId: "manager",
    access: { tenantId: "tenant-a", permissions },
  }) as any;
const now = new Date("2026-11-07T12:00:00Z");
const run = (permissions?: readonly string[], date = "2026-11-07") =>
  buildDashboardManagement({
    context: context(permissions),
    query: { date },
    now,
  });
const tenant = {
  modules: {
    bookings: true,
    payments: true,
    customers: true,
    courses: true,
    memberships: true,
    vouchers: true,
    communications: true,
  },
  settings: { currency: "CZK", timezone: "Europe/Prague" },
  plan: "professional",
  planVersion: 3,
};
const booking = {
  _id: "booking-a",
  location: "studio-a",
  start: "2026-11-03T14:00:00Z",
  end: "2026-11-03T16:00:00Z",
  tag: "open-studio",
  status: "delivered",
  paymentStatus: "CONFIRMED",
  createdBy: "customer-a",
  author: { name: "Ada" },
  numberOfGuests: 2,
};
const modelNames = [
  "booking",
  "order",
  "customOrder",
  "membership",
  "refund",
  "coupon",
  "ledger",
  "email",
  "invoice",
  "user",
] as const;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.customerDetails.mockImplementation(async () => ({ details: new Map(), queryLimitExceeded: false }));
  mocks.spendingRanking.mockImplementation(async ({ enabled, canRankCustomers }) => ({
    available: enabled, rankingAvailable: enabled && canRankCustomers, items: [], complete: enabled,
    queryLimitExceeded: false, currentPaymentsMinor: enabled ? 0 : null,
    comparisonPaymentsMinor: enabled ? 0 : null, currentPaymentsComplete: enabled,
    comparisonPaymentsComplete: enabled, unknownPaymentCount: 0,
  }));
  mocks.nativeInvoicing.mockReturnValue(true);
  mocks.tenant.mockImplementation(() => chain(tenant));
  mocks.scope.mockResolvedValue({
    locationIds: ["studio-a"],
    requestedLocationId: null,
    allowedLocationIds: ["studio-a"],
    unrestricted: false,
  });
  mocks.entitlement.mockReturnValue({
    tier: "advanced",
    courseOnly: false,
    firingActivity: false,
    studioOperations: true,
    consolidatedLocations: true,
  });
  for (const name of modelNames)
    mocks[name].mockImplementation(() => chain([]));
});

describe("owner/manager management data boundaries", () => {
  it("never reads or reports pottery-only sources", async () => {
    const result = await run();
    expect(result).not.toHaveProperty("firings");
    expect(result).not.toHaveProperty("lostPieces");
    expect(result.summary).not.toHaveProperty("firingCompletions");
    expect(result.issues.some((issue) => issue.key === "missing_items")).toBe(false);
    expect(JSON.stringify(result.coverage)).not.toMatch(/firing|lostPieces|piece/i);
  });

  it("preserves the selected studio in the bounded sales query for an unrestricted owner", async () => {
    const studioId = "507f1f77bcf86cd799439011";
    mocks.scope.mockResolvedValue({
      locationIds: [studioId],
      requestedLocationId: studioId,
      allowedLocationIds: null,
      unrestricted: false,
    });
    await run();
    // A broad read can hit MAX_ROWS because of other studios and wrongly
    // make this studio's cash and confirmed service statistics unavailable.
    const salesFilter = mocks.order.mock.calls[0]?.[0];
    expect(salesFilter).toBeDefined();
    expect(salesFilter.$and).toEqual(expect.arrayContaining([
      { locationIds: studioId },
    ]));
  });
  it("returns workspace customer totals/new registrations and distinct creation-based activity for a selected studio", async () => {
    mocks.scope.mockResolvedValue({ locationIds: ["studio-a"], requestedLocationId: "studio-a", allowedLocationIds: null, unrestricted: false });
    mocks.user.mockImplementation(() => chain([
      { _id: "customer-a", createdAt: "2026-01-01" },
      { _id: "customer-b", createdAt: "2026-11-02" },
    ]));
    mocks.booking.mockImplementation((filter) => chain(filter.createdAt ? [
      { ...booking, createdAt: "2026-11-02", start: "2027-01-01", end: "2027-01-02" },
      { ...booking, createdAt: "2026-11-03" },
      { ...booking, createdBy: "staff", createdAt: "2026-11-03" },
    ] : []));
    const result = await run();
    expect(result.customers).toMatchObject({
      available: true, scope: "workspace", activeScope: "selected_locations",
      total: { value: 2, previous: 1 }, new: { value: 1, previous: 0 },
      activeLast30Days: { value: 1, previous: 0 },
    });
    expect(result.metadata.activeCustomerPeriod).toEqual({ from: "2026-10-09", to: "2026-11-07" });
    expect(mocks.user.mock.calls[0][0]).toMatchObject({ tenant: "tenant-a", tenantRole: "customer", createdAt: { $lt: now } });
    expect(mocks.user.mock.calls[0][0]._id).toBeUndefined();
  });
  it("resolves only scoped activity identities for restricted staff and never exposes workspace registrations", async () => {
    mocks.booking.mockImplementation((filter) => chain(filter.createdAt ? [{ ...booking, createdAt: "2026-11-03" }] : []));
    mocks.user.mockImplementation(() => chain([{ _id: "customer-a", createdAt: "2026-01-01" }]));
    const result = await run();
    expect(result.customers.total.value).toBeNull();
    expect(result.customers.new.value).toBeNull();
    expect(result.customers.activeLast30Days.value).toBe(1);
    expect(result.customers.available).toBe(true);
    expect(mocks.user.mock.calls[0][0]._id).toEqual({ $in: ["customer-a"] });
  });
  it("does not present open-studio-only activity as a complete total when an enabled course source is denied", async () => {
    mocks.scope.mockResolvedValue({ locationIds: ["studio-a"], requestedLocationId: "studio-a", allowedLocationIds: null, unrestricted: false });
    mocks.booking.mockImplementation((filter) => chain(filter.createdAt ? [{ ...booking, createdAt: "2026-11-03" }] : []));
    mocks.user.mockImplementation(() => chain([{ _id: "customer-a", createdAt: "2026-01-01" }]));
    for (const permission of ["courses.view", "products.view"]) {
      const result = await run(ALL_WORKSPACE_PERMISSIONS.filter((entry) => entry !== permission));
      expect(result.customers.total.value).toBe(1);
      expect(result.customers.activeLast30Days.value).toBeNull();
      expect(result.coverage.unavailable).toContainEqual({ source: "courses", reason: "permission_denied" });
    }
    mocks.tenant.mockImplementation(() => chain({ ...tenant, modules: { ...tenant.modules, courses: false } }));
    expect((await run()).customers.activeLast30Days.value).toBe(1);
  });
  it("keeps distinct new subscribers separate from membership starts", async () => {
    mocks.membership.mockImplementation(() => chain([
      { user: "a", status: "expired", startedAt: "2025-01-01", currentPeriodEnd: "2025-02-01" },
      { user: "a", status: "active", startedAt: "2026-11-01", currentPeriodEnd: "2026-12-01" },
      { user: "b", status: "active", startedAt: "2026-11-02", currentPeriodEnd: "2026-12-02" },
    ]));
    const result = await run();
    expect(result.summary.activeMemberships.value).toBe(2);
    expect(result.memberships.new.value).toBe(2);
    expect(result.memberships.newSubscribers.value).toBe(1);
    expect(result.memberships.scope).toBe("selected_locations");
  });
  it("enriches the ranked customers with workspace cash for an all-location owner selecting one studio", async () => {
    mocks.scope.mockResolvedValue({ locationIds: ["studio-a"], requestedLocationId: "studio-a", allowedLocationIds: null, unrestricted: false });
    mocks.booking.mockImplementation((filter) => chain(filter.$or?.[0]?.start?.$gte ? [booking] : []));
    mocks.customerDetails.mockResolvedValue({ details: new Map([["customer-a", { memberNumber: 42, spentMonthMinor: 12000, spentTotalMinor: 45000 }]]), queryLimitExceeded: false });
    const result = await run();
    expect(mocks.customerDetails).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", customerIds: ["customer-a"], canViewSpending: true, asOf: now }));
    expect(result.topClients).toMatchObject({ spendingAvailable: true, spendingScope: "workspace", spendingBasis: "recorded_net_payments" });
    expect(result.topClients.byVisits[0]).toMatchObject({ id: "customer-a", memberNumber: 42, spentMonthMinor: 12000, spentTotalMinor: 45000 });
  });
  it("keeps workspace spending unavailable for restricted managers and incomplete financial permissions", async () => {
    await run();
    expect(mocks.customerDetails).toHaveBeenLastCalledWith(expect.objectContaining({ canViewSpending: false }));
    mocks.scope.mockResolvedValue({ locationIds: ["studio-a"], requestedLocationId: "studio-a", allowedLocationIds: null, unrestricted: false });
    for (const missing of ["customers.view", "orders.view", "payments.view", "vouchers.view", "memberships.view"]) {
      const result = await run(ALL_WORKSPACE_PERMISSIONS.filter((permission) => permission !== missing));
      expect(mocks.customerDetails).toHaveBeenLastCalledWith(expect.objectContaining({ canViewSpending: false }));
      expect(result.topClients.spendingAvailable).toBe(false);
    }
  });
  it("hides paused native invoice issues and links failed emails to their history", async () => {
    mocks.nativeInvoicing.mockReturnValue(false);
    mocks.email.mockImplementation(() =>
      chain([{ _id: "failed-email", status: "failed" }]),
    );
    const result = await run();
    expect(mocks.invoice).not.toHaveBeenCalled();
    expect(result.coverage.unavailable).toContainEqual({
      source: "paymentIssues",
      reason: "module_disabled",
    });
    expect(result.issues).toContainEqual({
      key: "failed_emails",
      count: 1,
      href: "/app/communications?section=history",
    });
    expect(
      result.issues.some((issue) => issue.key === "overdue_invoices"),
    ).toBe(false);
  });
  it("does not query data sources without their permissions", async () => {
    const result = await run([]);
    for (const name of modelNames)
      expect(mocks[name], name).not.toHaveBeenCalled();
    expect(result.summary.visits.value).toBeNull();
    expect(result.topClients.byVisits).toEqual([]);
    expect(result.cash.receivedMinor.value).toBeNull();
  });
  it("scopes all source reads to the tenant and attributed data to allowed studios", async () => {
    await run();
    for (const name of modelNames)
      for (const [filter] of mocks[name].mock.calls)
        expect(filter.tenant, name).toBe("tenant-a");
    for (const name of [
      "booking",
      "customOrder",
      "email",
    ] as const)
      for (const [filter] of mocks[name].mock.calls)
        expect(filter.location, name).toEqual({ $in: ["studio-a"] });
    expect(mocks.membership.mock.calls[0][0].$or).toEqual([
      { selectedLocation: { $in: ["studio-a"] } },
      { selectedLocation: null, "planSnapshot.locationScope.type": "all" },
      { "planSnapshot.locationScope.type": "shared_selected", "planSnapshot.locationScope.locationIds": { $in: ["studio-a"] } },
    ]);
    expect(mocks.coupon).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
  it("honors plan entitlements before querying financial/operational sources", async () => {
    mocks.entitlement.mockReturnValue({
      tier: "limited",
      courseOnly: true,
      firingActivity: false,
      studioOperations: false,
      consolidatedLocations: false,
    });
    const result = await run();
    expect(mocks.customerDetails).toHaveBeenCalledWith(expect.objectContaining({ canViewSpending: false }));
    for (const name of [
      "customOrder",
      "membership",
      "refund",
      "invoice",
      "email",
    ] as const)
      expect(mocks[name], name).not.toHaveBeenCalled();
    // Course-only plans may count reservation customers, without financial
    // reads or exposing any order amount/payment fields.
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(mocks.order.mock.calls[0][0]["courseBookings.0"]).toEqual({ $exists: true });
    expect(mocks.order.mock.results[0].value.select).toHaveBeenCalledWith(
      "_id createdBy createdAt paidAt isPaid status courseBookings.bookingId courseBookings.quantity",
    );
    expect(result.attendance.openStudio.value).toBeNull();
    expect(mocks.booking.mock.calls[0][0].tag.$in).toEqual(["class", "course"]);
    mocks.scope.mockResolvedValue({
      locationIds: ["a", "b"],
      requestedLocationId: null,
      allowedLocationIds: null,
      unrestricted: true,
    });
    await expect(run()).rejects.toMatchObject({
      code: "CONSOLIDATED_REPORTING_NOT_ENTITLED",
    });
  });
  it("labels scheduled attendance and does not recognize automatic delivered flags as revenue", async () => {
    mocks.booking.mockImplementation((filter) =>
      chain(filter.$or?.[0]?.start?.$gte ? [booking] : []),
    );
    const result = await run();
    expect(result.summary.visits.value).toBe(2);
    expect(result.attendance.hours[15].count).toBe(2);
    expect(result.attendance.source).toBe("scheduled");
    expect(result.summary.deliveredRevenueMinor.value).toBeNull();
    expect(result.summary.newCustomers.value).toBe(1);
    expect(result.topClients.byVisits[0]).toMatchObject({
      name: "Ada",
      visits: 1,
    });
    expect(result.coverage.complete).toBe(false);
  });
  it("includes services that start before the comparison window and finish inside it", async () => {
    mocks.booking.mockImplementation((filter) =>
      chain(
        filter.$or?.[0]?.start?.$gte
          ? [
              {
                ...booking,
                start: "2026-09-30",
                end: "2026-10-02",
                status: "completed",
              },
            ]
          : [],
      ),
    );
    mocks.order.mockImplementation(() =>
      chain([
        {
          currency: "CZK",
          status: "processed_order",
          createdBy: "customer-a",
          grossAmountMinor: 12100,
          lineItems: [
            {
              booking: "booking-a",
              product: "p",
              description: "Course",
              quantity: 1,
              grossAmountMinor: 12100,
              netAmountMinor: 10000,
              taxAmountMinor: 2100,
              locationIds: ["studio-a"],
            },
          ],
        },
      ]),
    );
    const result = await run();
    expect(result.revenueBreakdown.confirmedServicesMinor.previous).toBe(10000);
    expect(mocks.booking.mock.calls[0][0].$or[1].end.$gte).toEqual(
      new Date("2026-09-30T22:00:00Z"),
    );
  });
  it("recognizes explicit completed unpaid services independently from attendance/payment eligibility", async () => {
    mocks.booking.mockImplementation((filter) =>
      chain(
        filter.$or?.[0]?.start?.$gte
          ? [
              {
                ...booking,
                status: "completed",
                paymentStatus: "PENDING_PAYMENT",
              },
            ]
          : [],
      ),
    );
    mocks.order.mockImplementation(() =>
      chain([
        {
          currency: "CZK",
          status: "pending_order",
          createdBy: "customer-a",
          grossAmountMinor: 12100,
          lineItems: [
            {
              booking: "booking-a",
              product: "p",
              description: "Course",
              quantity: 1,
              grossAmountMinor: 12100,
              netAmountMinor: 10000,
              taxAmountMinor: 2100,
              locationIds: ["studio-a"],
            },
          ],
        },
      ]),
    );
    const result = await run();
    expect(result.revenueBreakdown.confirmedServicesMinor.value).toBe(10000);
    expect(result.summary.visits.value).toBe(0);
    expect(
      mocks.order.mock.calls[0][0].$or[0]["lineItems.booking"].$in,
    ).toEqual(["booking-a"]);
  });
  it("checks historical bookings within the authorized scope before counting a new client", async () => {
    mocks.booking.mockImplementation((filter) =>
      chain(
        filter.$or?.[0]?.start?.$gte
          ? [booking]
          : filter.start?.$lt
            ? [{ ...booking, start: "2025-01-03", end: "2025-01-04" }]
            : [],
      ),
    );
    const result = await run();
    expect(result.summary.newCustomers.value).toBe(0);
    const historyFilter = mocks.booking.mock.calls.find(
      ([filter]) => filter.start?.$lt,
    )?.[0];
    expect(historyFilter.location).toEqual({ $in: ["studio-a"] });
  });
  it("includes dated refunds of future/cancelled bookings only after resolving their authorized studio", async () => {
    mocks.refund.mockImplementation(() =>
      chain([
        {
          _id: "r1",
          booking: "cancelled",
          currency: "CZK",
          cardAmountMinor: 2000,
          completedAt: "2026-11-04",
        },
        {
          _id: "r2",
          booking: "other-studio",
          currency: "CZK",
          cardAmountMinor: 9000,
          completedAt: "2026-11-04",
        },
      ]),
    );
    mocks.booking.mockImplementation((filter) =>
      chain(filter._id ? [{ _id: "cancelled" }] : []),
    );
    const result = await run();
    expect(result.cash.refundsMinor.value).toBe(2000);
    expect(result.cash.refundCount.value).toBe(1);
    expect(result.cash.complete).toBe(false);
    expect(result.cash.netReceivedMinor.value).toBeNull();
  });
  it("does not turn truncated source reads into plausible totals", async () => {
    mocks.booking.mockImplementation(() =>
      chain(Array.from({ length: 20001 }, () => booking)),
    );
    const result = await run();
    expect(result.summary.visits.value).toBeNull();
    expect(result.attendance.available).toBe(false);
    expect(result.coverage.unavailable).toContainEqual({
      source: "bookings",
      reason: "query_limit_exceeded",
    });
  });
  it("does not project today's active membership state into historical months", async () => {
    mocks.membership.mockImplementation(() =>
      chain([
        {
          user: "customer-a",
          status: "active",
          startedAt: "2026-01-01",
          currentPeriodEnd: "2026-12-01",
        },
      ]),
    );
    expect((await run()).summary.activeMemberships).toMatchObject({
      value: 1,
      previous: null,
    });
    const past = await run(undefined, "2026-10-07");
    expect(past.summary.activeMemberships.value).toBeNull();
    expect(past.metadata.snapshotAsOf).toBe(now.toISOString());
  });
});

describe("payment-based dashboard rankings", () => {
  it("ranks a paying customer without any visits or registration date and without booking permission", async () => {
    mocks.scope.mockResolvedValue({ locationIds: ["studio-a"], requestedLocationId: "studio-a", allowedLocationIds: null, unrestricted: false });
    mocks.spendingRanking.mockResolvedValue({ available: true, rankingAvailable: true, complete: false,
      items: [{ id: "payer", name: "Paying customer", visits: 0, revenueMinor: 45000, spentMonthMinor: 45000, spentMonthComplete: false }],
      currentPaymentsMinor: 45000, comparisonPaymentsMinor: 20000, currentPaymentsComplete: false,
      comparisonPaymentsComplete: true, unknownPaymentCount: 1, queryLimitExceeded: false });
    const result = await run(ALL_WORKSPACE_PERMISSIONS.filter(permission => permission !== "bookings.view"));
    expect(result.topClients).toMatchObject({ available: true, revenueAvailable: true,
      revenueBasis: "recorded_net_payments", spendingRankingScope: "workspace", revenueComplete: false,
      byRevenue: [{ id: "payer", visits: 0, revenueMinor: 45000, spentMonthMinor: 45000, spentMonthComplete: false }] });
    expect(mocks.spendingRanking).toHaveBeenCalledWith(expect.objectContaining({ canRankCustomers: true, enabled: true }));
  });
  it("queries paid purchases over rolling 30 days independently of completed services and exposes count", async () => {
    mocks.order.mockImplementation(filter => chain(filter.status === "processed_order" && filter.isPaid === true && filter.$or ? [{
      _id: "purchase", status: "processed_order", isPaid: true, paidAt: new Date("2026-10-20T10:00:00Z"),
      lineItems: [{ product: "mug", description: "Mug", quantity: 3, locationIds: ["studio-a"] }],
    }] : []));
    const result = await run();
    expect(result.topProducts).toMatchObject({ available: true, complete: false, basis: "paid_purchases", scope: "selected_locations",
      period: { from: "2026-10-09", to: "2026-11-07" }, items: [{ id: "mug", quantity: 3, purchaseCount: 1 }] });
    const query = mocks.order.mock.calls.map(([filter]) => filter).find(filter => filter.status === "processed_order" && filter.$or);
    expect(query).toMatchObject({ tenant: "tenant-a", isPaid: true,
      $or: [{ paidAt: { $gte: new Date("2026-10-08T22:00:00Z"), $lt: now } }, { paidAt: null }] });
  });
});
