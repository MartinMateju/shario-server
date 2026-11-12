import { describe, expect, it } from "vitest";

import {
  buildReportCsv,
  csvCell,
  escapeCsvFormula,
} from "@/modules/reports/reports.csv.js";

describe("report CSV safety", () => {
  it.each(["=cmd()", "+SUM(A1)", "-danger", "@link", "\tformula", "\rformula"])(
    "neutralizes untrusted formula-like text %j",
    (value) => {
      expect(escapeCsvFormula(value)).toBe(`'${value}`);
    },
  );

  it("keeps real negative numeric values numeric and quotes RFC4180 text", () => {
    expect(escapeCsvFormula(-12.5)).toBe("-12.5");
    expect(csvCell('Clay, "white"')).toBe('"Clay, ""white"""');
  });

  it("emits exactly one BOM, CRLF rows and nullable unavailable values", () => {
    const csv = buildReportCsv({
      metadata: {
        currency: "CZK",
        timezone: "Europe/Prague",
        period: { from: "2026-07-01", to: "2026-07-28" },
        comparisonPeriod: { from: "2026-06-03", to: "2026-06-30" },
        locationId: null,
        granularity: "day",
        generatedAt: "2026-07-28T12:00:00.000Z",
      },
      summary: {
        netSales: { value: 10_000, previous: 8_000, changePercent: 25 },
        bookings: { value: null, previous: null, changePercent: null },
      },
      timeSeries: [],
      sales: {
        currency: "CZK",
        grossSalesMinor: 12_000,
        discountsMinor: 1_000,
        taxMinor: 1_000,
        netSalesMinor: 10_000,
        orders: 2,
        averageOrderValueMinor: 5_000,
        refundsMinor: null,
        totalsByCurrency: [
          {
            currency: "CZK",
            grossSalesMinor: 12_000,
            discountsMinor: 1_000,
            taxMinor: 1_000,
            netSalesMinor: 10_000,
            paidAmountMinor: 11_000,
            orders: 2,
          },
        ],
        paymentMethods: [{ method: "card", amountMinor: 11_000 }],
        topProducts: [
          {
            productId: "product-1",
            name: "=Clay",
            quantity: 2,
            netSalesMinor: 10_000,
            grossSalesMinor: 12_000,
          },
        ],
        limitations: [],
      },
      bookings: {
        total: 3,
        participants: 5,
        cancellations: 1,
        noShows: null,
        bookedHours: 6,
        utilizationPercent: 25,
        bookingTypes: [{ type: "studio", count: 3, participants: 5 }],
        courseFill: null,
        heatmap: [
          {
            weekday: 0,
            hour: 10,
            bookings: 1,
            participants: 2,
            capacity: 8,
            utilizationPercent: 25,
          },
        ],
        limitations: [],
      },
      customers: {
        active: 2,
        new: 1,
        returning: 1,
        returningRatePercent: 50,
        averageSpendMinor: 5_000,
        limitations: [],
      },
      operations: {
        firings: {
          asOf: "2026-07-28T12:00:00.000Z",
          completed: 1,
          previousCompleted: 0,
          changePercent: null,
          running: 1,
          pending: 2,
          averageTurnaroundHours: 12,
          piecesFired: 8,
          registeredPiecesAwaitingPickup: 3,
          limitations: [],
        },
        inventory: {
          asOf: "2026-07-28T12:00:00.000Z",
          consumptionByUnit: [{ unit: "kg", quantity: 4.5 }],
          purchasesByUnit: [],
          purchaseCostWithoutVatMinor: 2_000,
          openReorders: 1,
          lowStockItems: 2,
          stocktakeDifferenceByUnit: [],
          limitations: [],
        },
        staffTasks: {
          asOf: "2026-07-28T12:00:00.000Z",
          completed: 3,
          previousCompleted: 2,
          changePercent: 50,
          open: 4,
          overdue: 1,
          completionRatePercent: 75,
          limitations: [],
        },
      },
      coverage: {
        available: ["sales"],
        unavailable: [{ source: "bookings", reason: "=permission_required" }],
        limitations: [],
      },
    });

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.charAt(1)).not.toBe("\uFEFF");
    expect(csv).toContain("\r\n");
    expect(csv).toContain(
      '"metadata","locationScope","all_accessible"',
    );
    expect(csv).toContain(`"'=permission_required"`);
    expect(csv).toContain('"bookings","","","","count"');
    expect(csv).toContain(
      '"sales.totalsByCurrency","CZK","12000","1000","1000","10000","11000","2"',
    );
    expect(csv).toContain(
      '"sales.topProducts","product-1","\'=Clay","2","10000","12000","CZK"',
    );
    expect(csv).toContain(
      '"bookings.heatmap","0","10","1","2","8","25"',
    );
    expect(csv).toContain(
      '"operations.inventory.consumptionByUnit","kg","4.5"',
    );
    expect(csv).toContain(
      '"operations.staffTasks","overdue","1","count"',
    );
    expect(csv).toContain(
      '"bookings.courseFill","status","unavailable"',
    );
  });
});
