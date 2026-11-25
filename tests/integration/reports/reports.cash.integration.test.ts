import mongoose from "mongoose";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
  afterEach,
} from "vitest";
import Tenant from "@/modules/tenants/tenant.model.js";
import Location from "@/modules/location/location.model.js";
import Order from "@/modules/order/order.model.js";
import Booking from "@/modules/booking/booking.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { couponService } from "@/modules/coupon/coupon.service.js";
import MembershipInvoice from "@/modules/membership/membership-invoice.schema.js";
import User from "@/modules/user/user.model.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";
import { buildReportOverview } from "@/modules/reports/reports.service.js";
import { buildReportCsv } from "@/modules/reports/reports.csv.js";
import { listReportCustomers } from "@/modules/reports/reports.customer-service.js";
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const oid = () => new mongoose.Types.ObjectId();
const tenant = oid(),
  foreign = oid(),
  location = oid(),
  second = oid(),
  customer = oid(),
  product = oid();
const now = new Date("2026-11-17T12:00:00Z");
const context = (access: any = {}) => ({
  tenantId: String(tenant),
  userId: String(customer),
  access: {
    tenantId: String(tenant),
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
    preferences: { language: "en" },
    ...access,
  } as any,
});
const query = {
  from: "2026-09-01",
  to: "2026-11-17",
  compare: false,
  granularity: "month" as const,
};
const overview = (input: any = {}, access: any = {}) =>
  buildReportOverview({
    context: context(access),
    query: { ...query, ...input },
    now,
  });
const line = (amount = 10000, locations = [location]) => ({
  product,
  description: "Wheel session",
  quantity: 1,
  grossAmountMinor: amount,
  netAmountMinor: amount,
  taxAmountMinor: 0,
  locationIds: locations,
});
const order = (patch: any = {}) => ({
  _id: oid(),
  tenant,
  createdBy: customer,
  isPaid: true,
  status: "processed_order",
  paidAt: new Date("2026-09-10T10:00Z"),
  currency: "CZK",
  grossAmountMinor: 10000,
  paidAmountMinor: 10000,
  lineItems: [line()],
  locationIds: [location],
  paymentAllocations: [{ method: "stripe", amountMinor: 10000 }],
  ...patch,
});
const refund = (amount: number, patch: any = {}) => ({
  reconciliationId: "fixture",
  status: "partial",
  succeededAmountMinor: amount,
  pendingAmountMinor: 0,
  failedAmountMinor: 0,
  reviewRequired: false,
  reviewReason: "",
  snapshotVersion: "fixture",
  updatedAt: now,
  ...patch,
});

const confirmLegacyVoucher = async () => {
  const purchase = await couponRepository.createCouponOrderFromCheckout(
    String(tenant),
    { quantity: 1, email: "legacy@example.test", sendPost: false } as any,
    { _id: product, name: "Legacy voucher", price: 2000, currency: "CZK" },
  );
  purchase.stripeSessionId = `cs_legacy_${purchase._id}`;
  await purchase.save();
  // Historical purchases can have a linked customer. Public checkout no longer
  // accepts this identity from the request body.
  await CouponOrder.updateOne({ _id: purchase._id }, { createdBy: customer });
  // Exercise payment verification and its real database writes; issuance and
  // email delivery are outside this financial-read regression.
  const finalize = vi
    .spyOn(couponService, "finalizePaidCouponOrder")
    .mockResolvedValue(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T10:00Z"));
  try {
    await couponService.processLegacyPlatformCouponOrderFromWebhook({
      tenantId: String(tenant),
      session: {
        id: purchase.stripeSessionId,
        status: "complete",
        client_reference_id: `CO_${purchase._id}`,
        payment_status: "paid",
        payment_intent: `pi_legacy_${purchase._id}`,
        amount_total: 200000,
        currency: "czk",
        livemode: false,
      } as any,
      eventId: `evt_legacy_${purchase._id}`,
      livemode: false,
    });
  } finally {
    vi.useRealTimers();
    finalize.mockRestore();
  }
  return CouponOrder.findById(purchase._id).lean();
};

describe("Reports recorded cash and occupied-time integrity", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    // Raw collection fixtures still need to satisfy the production indexes.
    // Finish index creation before seeding so local and hosted runs enforce
    // the same constraints rather than racing Mongoose initialization.
    await Promise.all(
      [
        Tenant,
        Location,
        Order,
        Booking,
        BookingPaymentRefund,
        CouponOrder,
        MembershipInvoice,
        User,
      ].map((model) => model.init()),
    );
  });
  afterAll(disconnectTestDatabase);
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestDatabase();
    await Tenant.collection.insertOne({
      _id: tenant,
      plan: "professional",
      planVersion: 2,
      settings: { timezone: "Europe/Prague", currency: "CZK" },
      modules: {
        payments: true,
        bookings: true,
        customers: true,
        vouchers: true,
        memberships: true,
      },
    });
    const openingHours = Object.fromEntries(
      [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ].map((day) => [
        day,
        { isOpen: true, openTime: "00:00", closeTime: "24:00" },
      ]),
    );
    await Location.collection.insertMany([
      {
        _id: location,
        slug: "report-active-studio",
        code: "REPORT-ACTIVE",
        tenant,
        isActive: true,
        booking: { enabled: true, globalCapacity: 1 },
        openingHours,
      },
      {
        _id: second,
        slug: "report-inactive-studio",
        code: "REPORT-INACTIVE",
        tenant,
        isActive: false,
        booking: { enabled: true, globalCapacity: 1 },
        openingHours,
      },
    ]);
  });

  it("counts card, top-up, voucher and invoice cash once; later provider+managed refunds are not double deducted", async () => {
    const card = order({ refund: refund(2000) });
    await Order.collection.insertMany([
      card,
      order({
        grossAmountMinor: 5000,
        paidAmountMinor: 5000,
        lineItems: [],
        locationIds: [],
        creditPurchase: { amount: 50 },
        paidAt: new Date("2026-09-20T10:00Z"),
      }),
      ...["membership_credit", "credits", "voucher"].map((method) =>
        order({
          grossAmountMinor: 1350000,
          paidAmountMinor: 0,
          paymentAllocations: [{ method, amountMinor: 1350000 }],
        }),
      ),
      order({ tenant: foreign, paidAmountMinor: 9000000 }),
      order({ paidAt: new Date("2026-08-10T10:00Z"), paidAmountMinor: 100 }),
    ]);
    await BookingPaymentRefund.collection.insertOne({
      _id: "managed-fixture",
      tenant,
      order: card._id,
      customer,
      currency: "CZK",
      status: "succeeded",
      cardAmountMinor: 2000,
      completedAt: now,
    });
    await CouponOrder.collection.insertOne({
      _id: oid(),
      tenant,
      createdBy: customer,
      paidAt: new Date("2026-10-05T10:00Z"),
      currencySnapshot: "CZK",
      expectedAmountMinor: 2000,
      refundedAmountMinor: 500,
      status: "processed_coupon",
    });
    await MembershipInvoice.collection.insertOne({
      _id: oid(),
      tenant,
      user: customer,
      paidAt: new Date("2026-10-10T10:00Z"),
      currency: "CZK",
      amountPaidMinor: 10000,
      status: "paid",
      refund: refund(1000),
    });
    const report = await overview();
    expect(report.sales).toMatchObject({
      cashReceivedMinor: 23500,
      netSalesMinor: 23500,
      paymentCount: 4,
      bestMonth: { month: "2026-09", cashReceivedMinor: 13000 },
    });
    expect(report.sales!.monthlyRanking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          month: "2026-10",
          cashReceivedMinor: 10500,
          completeMonth: true,
          dataComplete: true,
        }),
        expect.objectContaining({ month: "2026-11", completeMonth: false }),
      ]),
    );
    expect(report.customers).toMatchObject({
      active: 1,
      returning: 1,
      new: 0,
      averageSpendMinor: 23500,
    });
    expect(report.sales!.topProducts![0].netSalesMinor).toBe(8000);
    expect(report.metadata).toMatchObject({
      moneyBasis: "recorded_cash_after_refunds",
      refundBasis: "current_recorded_state",
      cashAsOf: now.toISOString(),
    });
    const csv = buildReportCsv(report);
    expect(csv).toContain('"cashReceivedMinor"');
    for (const field of [
      "grossSalesMinor",
      "taxMinor",
      "discountsMinor",
      "refundsMinor",
    ])
      expect(csv).not.toContain(field);
  });

  it("includes confirmed legacy voucher cash and refunds in months, spending and first-payment history", async () => {
    const purchase = await confirmLegacyVoucher();
    expect(purchase).toMatchObject({
      expectedAmountMinor: 0,
      totalSnapshot: 2000,
      paidAt: new Date("2026-10-05T10:00Z"),
      stripePaymentIntentId: expect.stringMatching(/^pi_/),
    });
    await CouponOrder.updateOne(
      { _id: purchase!._id },
      { refundedAmountMinor: 50000 },
    );
    const manual = await couponRepository.createManualCouponOrder({
      tenantId: String(tenant),
      product: { _id: product, name: "Gift", price: 2000, currency: "CZK" },
      email: "legacy@example.test",
      couponId: oid(),
      promoCode: "MANUAL-GIFT",
      createdBy: String(customer),
    });
    await CouponOrder.updateOne(
      { _id: manual._id },
      { paidAt: new Date("2026-09-01T10:00Z") },
    );
    await CouponOrder.collection.insertOne({
      _id: oid(),
      tenant,
      createdBy: customer,
      expectedAmountMinor: 0,
      totalSnapshot: 0,
      currencySnapshot: "CZK",
      paidAt: new Date("2026-09-02T10:00Z"),
      stripeSessionId: "cs_free_voucher",
    });
    await User.collection.insertOne({
      _id: customer,
      tenant,
      tenantRole: "customer",
      platformRole: "none",
      firstname: "Legacy",
      lastname: "Customer",
      email: "legacy@example.test",
      customId: "legacy-voucher-customer",
      memberNumber: 1,
      createdAt: new Date("2025-01-01T00:00Z"),
    });
    await Order.collection.insertOne(
      order({ paidAt: new Date("2026-11-02T10:00Z") }),
    );

    const report = await overview();
    expect(report.sales).toMatchObject({
      cashReceivedMinor: 160000,
      paymentCount: 2,
      bestMonth: { month: "2026-10", cashReceivedMinor: 150000 },
    });
    expect(report.sales!.monthlyRanking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          month: "2026-09",
          cashReceivedMinor: 0,
          paymentCount: 0,
        }),
        expect.objectContaining({
          month: "2026-10",
          cashReceivedMinor: 150000,
          paymentCount: 1,
          dataComplete: true,
        }),
      ]),
    );
    expect(
      (await overview({ from: "2026-10-01", to: "2026-10-31" })).customers,
    ).toMatchObject({
      active: 1,
      new: 1,
      returning: 0,
      averageSpendMinor: 150000,
    });
    expect(
      (await overview({ from: "2026-11-01", to: "2026-11-17" })).customers,
    ).toMatchObject({
      active: 1,
      new: 0,
      returning: 1,
      averageSpendMinor: 10000,
    });
    const customers = await listReportCustomers({
      context: context(),
      input: {
        from: "2026-10-01",
        to: "2026-10-31",
        spendMin: 1500,
        spendMax: 1500,
      },
      now,
    });
    expect(customers.data).toEqual([
      expect.objectContaining({ id: String(customer), paidSpendMinor: 150000 }),
    ]);
  });

  it.each([
    { totalSnapshot: 1.001 },
    { currencySnapshot: "XXX" },
    { refundedAmountMinor: 200001 },
    { refundState: "manual_review" },
    { paidAt: null, status: "processed_coupon" },
  ])(
    "keeps inconsistent legacy voucher evidence unknown: %j",
    async (patch) => {
      const purchase = await confirmLegacyVoucher();
      await CouponOrder.collection.updateOne(
        { _id: purchase!._id },
        { $set: patch },
      );
      const report = await overview();
      expect(report.sales!.cashReceivedMinor).toBeNull();
      expect(report.sales!.bestMonth).toBeNull();
      expect(
        report.sales!.monthlyRanking.find((row) => row.month === "2026-10"),
      ).toMatchObject({ cashReceivedMinor: null, dataComplete: false });
      expect(report.customers!.averageSpendMinor).toBeNull();
    },
  );

  it("keeps partial multi-line refund activity attribution unknown while preserving monthly cash", async () => {
    await Order.collection.insertOne(
      order({
        grossAmountMinor: 20000,
        paidAmountMinor: 20000,
        lineItems: [
          line(),
          { ...line(), product: oid(), description: "Modelling" },
        ],
        refund: refund(5000),
      }),
    );
    const report = await overview();
    expect(report.sales!.netSalesMinor).toBe(15000);
    expect(report.sales!.bestMonth!.cashReceivedMinor).toBe(15000);
    expect(
      report.sales!.topProducts!.every((row) => row.netSalesMinor === null),
    ).toBe(true);
    expect(report.sales!.topProductsComplete).toBe(false);
    expect(report.coverage.limitations.join(" ")).toContain("refund-to-line");
  });

  it("keeps an unreconciled successful added-time refund unknown instead of counting the original cash", async () => {
    await Order.collection.insertOne(
      order({
        expectedAmountMinor: 10000,
        bookingExtension: {
          bookingId: oid(),
          refundStatus: "succeeded",
          refundId: "re_extension_fixture",
        },
      }),
    );
    const report = await overview();
    expect(report.sales!.netSalesMinor).toBeNull();
    expect(report.sales!.bestMonth).toBeNull();
    expect(report.coverage.limitations.join(" ")).toContain(
      "refund allocations",
    );
  });

  it("does not let no-date zero-cash redemptions poison real cash totals", async () => {
    const legacy = order({
      paidAt: null,
      paymentAllocations: [{ method: "membership_credit", amountMinor: 10000 }],
    });
    delete (legacy as any).paidAmountMinor;
    await Order.collection.insertMany([
      order(),
      legacy,
      order({
        paidAt: null,
        paidAmountMinor: 0,
        paymentAllocations: [
          { method: "membership_credit", amountMinor: 10000 },
        ],
      }),
    ]);
    expect((await overview()).sales!.netSalesMinor).toBe(10000);
  });

  it("keeps currencies separate and includes money received before fulfilment finishes", async () => {
    await Order.collection.insertMany([
      order({ status: "pending_order" }),
      order({
        currency: "EUR",
        paidAmountMinor: 4000,
        grossAmountMinor: 4000,
        lineItems: [line(4000)],
      }),
    ]);
    const report = await overview();
    expect(report.sales!.netSalesMinor).toBe(10000);
    expect(report.sales!.totalsByCurrency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: "EUR", cashReceivedMinor: 4000 }),
      ]),
    );
    expect(report.sales!.paymentCount).toBe(1);
    expect(report.coverage.complete).toBe(false);
  });

  it("uses unknown for missing payment dates/refund review and never declares a best complete month", async () => {
    await Order.collection.insertMany([
      order(),
      order({ paidAt: null, paidAmountMinor: 500 }),
      order({
        paidAt: new Date("2026-10-10T10:00Z"),
        refund: refund(100, { reviewRequired: true, status: "review" }),
      }),
    ]);
    const report = await overview();
    expect(report.summary.netSales.value).toBeNull();
    expect(report.sales!.bestMonth).toBeNull();
    expect(
      report.sales!.monthlyRanking.every(
        (row) => row.cashReceivedMinor === null,
      ),
    ).toBe(true);
    expect(report.timeSeries.every((row) => row.netSalesMinor === null)).toBe(
      true,
    );
    expect(report.coverage.complete).toBe(false);
  });

  it("keeps unknown paid customer identities separate from known payers with refund review", async () => {
    const missing = order();
    delete (missing as any).paidAmountMinor;
    await Order.collection.insertMany([order(), missing]);
    let report = await overview();
    expect(report.customers).toMatchObject({
      active: null,
      new: null,
      returning: null,
      averageSpendMinor: null,
    });
    await Order.deleteOne({ _id: missing._id });
    await Order.collection.insertOne(
      order({
        refund: refund(100, { status: "review", reviewRequired: true }),
      }),
    );
    report = await overview();
    expect(report.customers).toMatchObject({
      active: 1,
      new: 1,
      returning: 0,
      averageSpendMinor: null,
    });
  });

  it("allocates selected-studio cash and excludes locationless receipts, other studios and foreign tenants", async () => {
    await Order.collection.insertMany([
      order({
        lineItems: [line(10000, [location, second])],
        locationIds: [location, second],
      }),
      order({
        lineItems: [],
        locationIds: [],
        creditPurchase: { amount: 100 },
      }),
      order({ locationIds: [second], lineItems: [line(10000, [second])] }),
      order({ tenant: foreign }),
    ]);
    await CouponOrder.collection.insertOne({
      _id: oid(),
      tenant,
      createdBy: customer,
      paidAt: new Date("2026-10-05T10:00Z"),
      currencySnapshot: "CZK",
      expectedAmountMinor: 50000,
      status: "processed_coupon",
    });
    const report = await overview({ locationId: String(location) });
    expect(report.sales!.netSalesMinor).toBe(5000);
    expect(report.coverage.complete).toBe(false);
    expect(report.sales!.limitations.join(" ")).toContain("all-studio");
    const denied = await overview({}, { permissions: ["reports.view"] });
    expect(denied.sales).toBeNull();
  });

  it("excludes locationless order cash without full financial permissions", async () => {
    await Order.collection.insertMany([
      order(),
      order({ lineItems: [], locationIds: [], paidAmountMinor: 90000 }),
    ]);
    const report = await overview(
      {},
      { permissions: ["reports.view", "orders.view", "payments.view"] },
    );
    expect(report.sales!.netSalesMinor).toBeNull();
    expect(report.sales!.bestMonth).toBeNull();
  });

  it("clips occupied time across midnight and includes overlap starting before the period", async () => {
    await Booking.collection.insertMany([
      {
        _id: oid(),
        tenant,
        location,
        tag: "open-studio",
        status: "processed",
        paymentStatus: "CONFIRMED",
        numberOfGuests: 1,
        start: new Date("2026-11-16T22:00Z"),
        end: new Date("2026-11-17T00:00Z"),
      },
      {
        _id: oid(),
        tenant,
        location,
        tag: "open-studio",
        status: "processed",
        paymentStatus: "CONFIRMED",
        numberOfGuests: 1,
        start: new Date("2026-11-17T22:00Z"),
        end: new Date("2026-11-18T00:00Z"),
      },
    ]);
    const report = await overview({
      from: "2026-11-17",
      to: "2026-11-17",
      granularity: "day",
    });
    expect(report.bookings).toMatchObject({
      total: 1,
      bookedHours: 2,
      utilizationPercent: 8.33,
    });
    expect(
      report
        .bookings!.heatmap.filter((row) => row.participants)
        .map((row) => [row.weekday, row.hour]),
    ).toEqual([
      [1, 0],
      [1, 23],
    ]);
  });

  it("excludes inactive-location occupied hours from utilization numerator while retaining historical booking counts", async () => {
    await Booking.collection.insertOne({
      _id: oid(),
      tenant,
      location: second,
      tag: "open-studio",
      status: "processed",
      paymentStatus: "CONFIRMED",
      numberOfGuests: 1,
      start: new Date("2026-11-17T08:00Z"),
      end: new Date("2026-11-17T10:00Z"),
    });
    const report = await overview({
      from: "2026-11-17",
      to: "2026-11-17",
      granularity: "day",
    });
    expect(report.bookings).toMatchObject({
      total: 1,
      bookedHours: 2,
      utilizationPercent: 0,
    });
    expect(
      report.bookings!.heatmap.every((row) => row.participants === 0),
    ).toBe(true);
  });

  it("groups first-payment history in MongoDB instead of fetching lifetime orders", async () => {
    await Order.collection.insertMany(
      Array.from({ length: 150 }, (_, index) =>
        order({
          paidAt: new Date(
            `2025-01-${String((index % 28) + 1).padStart(2, "0")}T10:00Z`,
          ),
        }),
      ).concat([order()]),
    );
    const aggregate = vi.spyOn(Order, "aggregate");
    const report = await overview();
    expect(report.customers).toMatchObject({ new: 0, returning: 1 });
    expect(
      aggregate.mock.calls.some(([stages]) =>
        (stages as any[]).some(
          (stage) => stage.$group?.paidAt?.$min === "$paidAt",
        ),
      ),
    ).toBe(true);
  });
});
