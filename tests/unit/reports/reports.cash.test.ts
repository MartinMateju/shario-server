import { describe, expect, it, vi } from "vitest";
import {
  buildCashMonthlyRanking,
  averageLinkedCustomerSpend,
  reportBookingSegments,
} from "@/modules/reports/reports.service.js";
import { resolveReportPeriod } from "@/modules/reports/reports.date.js";
import {
  isKnownCashlessOrder,
  recordedVoucherCash,
  recordedVoucherPaidMinor,
  firstReportPaymentDates,
  resolveReportCashSources,
} from "@/modules/reports/reports.cash.js";
import Order from "@/modules/order/order.model.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";

const tenantId = "000000000000000000000001";
const scope = {
  unrestricted: true,
  requestedLocationId: null,
  locationIds: [],
  allowedLocationIds: null,
};
const context = {
  tenantId,
  userId: tenantId,
  access: {
    tenantId,
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
  } as any,
};
const tenant = {
  planVersion: 2,
  modules: { payments: true, vouchers: true, memberships: true },
};
const period = (from: string, to: string) =>
  resolveReportPeriod({
    query: { from, to, compare: false, granularity: "month" },
    timezone: "Europe/Prague",
  }).current;

describe("recorded cash definitions and complete calendar months", () => {
  it("distinguishes explicit cashless legacy tenders from absent or mixed payment evidence", () => {
    expect(isKnownCashlessOrder({ paidAmountMinor: 0 })).toBe(true);
    for (const method of ["credits", "membership_credit", "voucher", "free"])
      expect(
        isKnownCashlessOrder({
          paymentAllocations: [{ method, amountMinor: 100 }],
        }),
      ).toBe(true);
    expect(isKnownCashlessOrder({})).toBe(false);
    expect(
      isKnownCashlessOrder({
        paymentAllocations: [
          { method: "credits", amountMinor: 100 },
          { method: "stripe", amountMinor: 100 },
        ],
      }),
    ).toBe(false);
    expect(
      isKnownCashlessOrder({
        paidAmountMinor: 100,
        paymentAllocations: [{ method: "credits", amountMinor: 100 }],
      }),
    ).toBe(false);
  });

  it("does not emit an unsafe average when customer cash totals overflow", () => {
    expect(
      averageLinkedCustomerSpend(
        [
          {
            createdBy: "a",
            currency: "CZK",
            _reportPeriod: "current",
            _reportNetSalesMinor: Number.MAX_SAFE_INTEGER,
          },
          {
            createdBy: "b",
            currency: "CZK",
            _reportPeriod: "current",
            _reportNetSalesMinor: 1,
          },
        ],
        "CZK",
      ),
    ).toBeNull();
  });

  it("keeps voucher review or impossible refund evidence unknown", () => {
    expect(
      recordedVoucherCash({
        expectedAmountMinor: 1000,
        refundedAmountMinor: 250,
      }),
    ).toBe(750);
    expect(
      recordedVoucherCash({
        expectedAmountMinor: 1000,
        refundedAmountMinor: 1001,
      }),
    ).toBeNull();
    expect(
      recordedVoucherCash({
        expectedAmountMinor: 1000,
        refundState: "manual_review",
      }),
    ).toBeNull();
    expect(
      recordedVoucherCash({
        expectedAmountMinor: 1000,
        refundFailureReviewRequired: true,
      }),
    ).toBeNull();
  });

  it("uses a confirmed legacy purchase total without counting manual voucher face value", () => {
    const legacy = {
      expectedAmountMinor: 0,
      currencySnapshot: "CZK",
      totalSnapshot: 20.25,
      stripeSessionId: "cs_legacy_payment",
    };
    expect(recordedVoucherPaidMinor(legacy)).toBe(2025);
    expect(recordedVoucherCash({ ...legacy, refundedAmountMinor: 25 })).toBe(
      2000,
    );
    expect(
      recordedVoucherCash({ ...legacy, refundedAmountMinor: 2026 }),
    ).toBeNull();
    expect(
      recordedVoucherCash({ ...legacy, refundState: "manual_review" }),
    ).toBeNull();
    expect(recordedVoucherPaidMinor({ ...legacy, stripeSessionId: "" })).toBe(
      0,
    );
    expect(recordedVoucherPaidMinor({ ...legacy, totalSnapshot: 0 })).toBe(0);
    expect(
      recordedVoucherPaidMinor({
        ...legacy,
        expectedAmountMinor: undefined,
        stripeSessionId: "",
        stripePaymentIntentId: "pi_legacy_payment",
      }),
    ).toBe(2025);
    expect(
      recordedVoucherPaidMinor({
        ...legacy,
        currencySnapshot: "JPY",
        totalSnapshot: 20,
      }),
    ).toBe(20);
    for (const patch of [
      { currencySnapshot: "JPY" },
      { currencySnapshot: "XXX" },
      { totalSnapshot: undefined },
      { totalSnapshot: "20.25" },
      { totalSnapshot: 1.001 },
      { totalSnapshot: Number.MAX_SAFE_INTEGER },
    ])
      expect(recordedVoucherCash({ ...legacy, ...patch })).toBeNull();
  });

  it("marks partial beginning/end and the still-current calendar month ineligible", () => {
    const rows = buildCashMonthlyRanking({
      period: period("2026-09-10", "2026-11-30"),
      timezone: "Europe/Prague",
      now: new Date("2026-11-17T12:00Z"),
      months: new Map(),
    });
    expect(rows.map((row) => [row.month, row.completeMonth])).toEqual([
      ["2026-09", false],
      ["2026-10", true],
      ["2026-11", false],
    ]);
    expect(rows[1]).toMatchObject({
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      cashReceivedMinor: 0,
      dataComplete: true,
    });
  });

  it("does not replace unknown month cash with zero", () => {
    const rows = buildCashMonthlyRanking({
      period: period("2026-09-01", "2026-10-31"),
      timezone: "Europe/Prague",
      now: new Date("2026-11-17T12:00Z"),
      months: new Map([
        ["2026-10", { amount: 500, complete: false, payments: 1 }],
      ]),
    });
    expect(rows[0].cashReceivedMinor).toBe(0);
    expect(rows[1]).toMatchObject({
      cashReceivedMinor: null,
      dataComplete: false,
      completeMonth: true,
    });
  });

  it.each([
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ])("clips %s to its actual DST day duration", (day, hours) => {
    const selected = period(day as string, day as string);
    const segments = reportBookingSegments({
      booking: {
        start: new Date(selected.start.valueOf() - 3_600_000),
        end: new Date(selected.endExclusive.valueOf() + 3_600_000),
      },
      period: selected,
      timezone: "Europe/Prague",
      granularity: "day",
    });
    expect(segments.reduce((sum, row) => sum + row.hours, 0)).toBe(hours);
    expect(new Set(segments.map((row) => row.key))).toEqual(new Set([day]));
  });

  it("preserves full legacy report sources when a stored tenant has no plan version", () => {
    const { planVersion: _planVersion, ...legacyTenant } = tenant;
    expect(
      resolveReportCashSources({ context, scope, tenant: legacyTenant }),
    ).toMatchObject({
      orders: true,
      vouchers: true,
      memberships: true,
      courseOnly: false,
      allowLocationless: true,
      complete: true,
    });
  });

  it("fails closed for disabled payments or missing full-workspace financial access", () => {
    expect(
      resolveReportCashSources({
        context,
        scope,
        tenant: { ...tenant, modules: { payments: false } },
      }).orders,
    ).toBe(false);
    const limited = {
      ...context,
      access: {
        ...context.access,
        permissions: ["reports.view", "orders.view", "payments.view"],
      },
    };
    expect(
      resolveReportCashSources({ context: limited, scope, tenant }),
    ).toMatchObject({
      orders: true,
      complete: false,
      vouchers: false,
      memberships: false,
      allowLocationless: false,
    });
  });

  it("does not derive course-only lifecycle dates from unrelated order history", async () => {
    const aggregate = vi.spyOn(Order, "aggregate");
    try {
      const result = await firstReportPaymentDates({
        context,
        scope,
        customerIds: [tenantId],
        sources: {
          orders: true,
          vouchers: false,
          memberships: false,
          courseOnly: true,
          allowLocationless: false,
          complete: true,
          limitations: [],
        },
      });
      expect(result.size).toBe(0);
      expect(aggregate).not.toHaveBeenCalled();
    } finally {
      aggregate.mockRestore();
    }
  });
});
