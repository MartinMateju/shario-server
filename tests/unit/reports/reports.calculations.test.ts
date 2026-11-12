import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { resolveReportPeriod } from "@/modules/reports/reports.date.js";
import {
  allocateOrderForReport,
  averageLinkedCustomerSpend,
  bookingReservations,
  buildUtilizationSeries,
  changePercent,
  finalizeTopProducts,
  openingHoursCapacity,
  reportSeriesValue,
} from "@/modules/reports/reports.service.js";

const objectId = () => new mongoose.Types.ObjectId().toString();

describe("report deterministic calculations", () => {
  it("does not return infinity when the previous denominator is zero", () => {
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(0, 0)).toBe(0);
    expect(changePercent(75, 50)).toBe(50);
    expect(changePercent(null, 50)).toBeNull();
  });

  it("splits a multi-location order line equally without duplicating revenue", () => {
    const first = objectId();
    const second = objectId();
    const limitations = new Set<string>();
    const allocation = allocateOrderForReport(
      {
        grossAmountMinor: 1_000,
        paidAmountMinor: 1_000,
        lineItems: [
          {
            product: objectId(),
            quantity: 2,
            grossAmountMinor: 1_000,
            netAmountMinor: 800,
            taxAmountMinor: 200,
            locationIds: [first, second],
          },
        ],
      },
      {
        requestedLocationId: first,
        locationIds: [first],
        allowedLocationIds: null,
        unrestricted: false,
      },
      {
        available: new Set(),
        unavailable: [],
        limitations,
      },
    );

    expect(allocation).toMatchObject({
      ratio: 0.5,
      grossSalesMinor: 500,
      taxMinor: 100,
      netSalesMinor: 400,
    });
    expect(allocation?.lines[0]._reportShare).toBe(0.5);
    expect([...limitations].join(" ")).toContain("split equally");
  });

  it("conserves odd minor units across separate location reports", () => {
    const locations = [objectId(), objectId()].sort();
    const order = {
      grossAmountMinor: 1_001,
      paidAmountMinor: 1_001,
      appliedDiscount: { amountMinor: 101 },
      lineItems: [
        {
          product: objectId(),
          description: "Shared item",
          quantity: 1,
          grossAmountMinor: 1_001,
          netAmountMinor: 801,
          taxAmountMinor: 200,
          locationIds: locations,
        },
      ],
    };
    const coverage = () => ({
      available: new Set<string>(),
      unavailable: [],
      limitations: new Set<string>(),
    });
    const scoped = locations.map((locationId) =>
      allocateOrderForReport(
        order,
        {
          requestedLocationId: locationId,
          locationIds: [locationId],
          allowedLocationIds: null,
          unrestricted: false,
        },
        coverage(),
      ),
    );
    const unrestricted = allocateOrderForReport(
      order,
      {
        requestedLocationId: null,
        locationIds: locations,
        allowedLocationIds: null,
        unrestricted: true,
      },
      coverage(),
    )!;
    const summed = (field: string) =>
      scoped.reduce(
        (sum, allocation) => sum + Number((allocation as any)?.[field] ?? 0),
        0,
      );

    for (const field of [
      "grossSalesMinor",
      "discountsMinor",
      "taxMinor",
      "netSalesMinor",
      "paidAmountMinor",
    ]) {
      expect(summed(field)).toBe((unrestricted as any)[field]);
    }
    expect(
      scoped.reduce(
        (sum, allocation) =>
          sum + Number(allocation?.lines[0]._reportGrossAmountMinor ?? 0),
        0,
      ),
    ).toBe(1_001);
    expect(
      scoped.reduce(
        (sum, allocation) =>
          sum + Number(allocation?.allocateMinorUnits(1_001) ?? 0),
        0,
      ),
    ).toBe(1_001);
    expect(scoped[0]?.lines[0]._reportGrossAmountMinor).toBe(501);
    expect(scoped[1]?.lines[0]._reportGrossAmountMinor).toBe(500);
  });

  it("marks tax-exclusive net as unavailable for unscoped legacy orders without lines", () => {
    const allocation = allocateOrderForReport(
      {
        grossAmountMinor: 1_000,
        paidAmountMinor: 1_000,
        lineItems: [],
      },
      {
        requestedLocationId: null,
        locationIds: [],
        allowedLocationIds: null,
        unrestricted: true,
      },
      {
        available: new Set(),
        unavailable: [],
        limitations: new Set(),
      },
    );
    expect(allocation?.grossSalesMinor).toBe(1_000);
    expect(allocation?.taxMinor).toBeNull();
    expect(allocation?.netSalesMinor).toBeNull();
  });

  it.each(["location", "restricted", "course"])(
    "does not include unallocatable legacy sales in a %s report",
    (kind) => {
      const location = objectId();
      const limitations = new Set<string>();
      const allocation = allocateOrderForReport(
        { grossAmountMinor: 1_000, paidAmountMinor: 1_000, lineItems: [] },
        {
          requestedLocationId: kind === "location" ? location : null,
          locationIds: [location],
          allowedLocationIds: kind === "restricted" ? [location] : null,
          unrestricted: kind === "course",
        },
        { available: new Set(), unavailable: [], limitations },
        kind === "course" ? () => true : undefined,
      );
      expect(allocation).toBeNull();
      expect([...limitations].join(" ")).toContain("exclude legacy orders");
    },
  );

  it("counts authoritative course order references before participant fallbacks", () => {
    const orderA = objectId();
    const orderB = objectId();
    expect(
      bookingReservations({
        tag: "course",
        orders: [orderA, orderA, orderB],
        participants: [],
        numberOfGuests: 8,
      }),
    ).toBe(2);
    expect(
      bookingReservations({
        tag: "course",
        orders: [],
        participants: [{ order: orderA }, { order: orderA }],
        numberOfGuests: 2,
      }),
    ).toBe(1);
    expect(bookingReservations({ tag: "workshop" })).toBe(1);
  });

  it("preserves paid reservation counts after attendance removal without resurrecting refunded orders", () => {
    const order = objectId();
    const booking = {
      tag: "course",
      attendanceManaged: true,
      orders: [order],
      participants: [{ order, attendanceStatus: "removed" }],
      numberOfGuests: 0,
    };
    expect(bookingReservations(booking)).toBe(1);
    expect(bookingReservations({ ...booking, orders: [] })).toBe(0);
    expect(
      bookingReservations({ ...booking, orders: [], numberOfGuests: 1 }),
    ).toBe(1);
  });

  it("uses only linked customer revenue in average spend", () => {
    const customer = objectId();
    expect(
      averageLinkedCustomerSpend(
        [
          {
            createdBy: customer,
            currency: "CZK",
            _reportPeriod: "current",
            _reportNetSalesMinor: 1_000,
          },
          {
            createdBy: null,
            currency: "CZK",
            _reportPeriod: "current",
            _reportNetSalesMinor: 50_000,
          },
        ],
        "CZK",
      ),
    ).toBe(1_000);
  });

  it("makes average spend unavailable when a linked order lacks net sales", () => {
    expect(
      averageLinkedCustomerSpend(
        [
          {
            createdBy: objectId(),
            currency: "CZK",
            _reportPeriod: "current",
            _reportNetSalesMinor: null,
          },
        ],
        "CZK",
      ),
    ).toBeNull();
  });

  it("preserves an explicitly unavailable sales bucket while zero-filling an absent one", () => {
    const series = new Map<string, number | null>([["2026-07-01", null]]);
    expect(reportSeriesValue(series, "2026-07-01")).toBeNull();
    expect(reportSeriesValue(series, "2026-07-02")).toBe(0);
  });

  it("reports zero utilization for known capacity with no bookings", () => {
    const result = buildUtilizationSeries(
      new Map([
        ["open", 20],
        ["closed", 0],
      ]),
      new Map([["booked", { participantHours: 2 }]]),
    );
    expect(result.get("open")).toBe(0);
    expect(result.get("closed")).toBeNull();
    expect(result.get("booked")).toBeNull();
  });

  it("does not present incomplete product net sales as zero", () => {
    const products = finalizeTopProducts([
      {
        productId: objectId(),
        name: "Legacy item",
        quantity: 1,
        netSalesMinor: 0,
        grossSalesMinor: 2_000,
        netSalesComplete: false,
      },
      {
        productId: objectId(),
        name: "Current item",
        quantity: 1,
        netSalesMinor: 800,
        grossSalesMinor: 1_000,
        netSalesComplete: true,
      },
    ]);
    expect(products[0]).toMatchObject({
      name: "Current item",
      netSalesMinor: 800,
    });
    expect(products[1]).toMatchObject({
      name: "Legacy item",
      netSalesMinor: null,
      grossSalesMinor: 2_000,
    });
  });

  it.each([
    ["2026-03-28", "2026-03-30"],
    ["2026-10-24", "2026-10-26"],
  ])(
    "counts opening capacity once per local day across DST from %s to %s",
    (from, to) => {
      const period = resolveReportPeriod({
        query: {
          from,
          to,
          compare: false,
          granularity: "day",
        },
        timezone: "Europe/Prague",
      }).current;
      const openingHours = Object.fromEntries(
        [
          "sunday",
          "monday",
          "tuesday",
          "wednesday",
          "thursday",
          "friday",
          "saturday",
        ].map((day) => [
          day,
          { isOpen: true, openTime: "00:00", closeTime: "24:00" },
        ]),
      );
      const capacity = openingHoursCapacity({
        locations: [
          {
            booking: { enabled: true, globalCapacity: 1 },
            openingHours,
          },
        ],
        period,
        timezone: "Europe/Prague",
        granularity: "day",
      });

      expect(capacity.total).toBe(72);
      expect([...capacity.byBucket.keys()]).toHaveLength(3);
      expect([...capacity.byBucket.values()]).toEqual([24, 24, 24]);
    },
  );
});
