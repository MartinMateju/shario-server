import { describe, expect, it } from "vitest";
import {
  calculateConfirmedServiceRevenue,
  managementBookingCustomers,
  managementKpi,
  managementParticipantCount,
  resolveManagementPeriods,
} from "@/modules/dashboard/dashboard-management.calculations.js";

const now = new Date("2026-11-07T12:00:00Z");
const periods = resolveManagementPeriods("2026-11-07", "Europe/Prague", now);
const booking = {
  _id: "b",
  tag: "open-studio",
  status: "completed",
  paymentStatus: "CONFIRMED",
  start: "2026-11-03T12:00:00Z",
  end: "2026-11-03T14:00:00Z",
  createdBy: "c",
};
const order = {
  currency: "CZK",
  status: "processed_order",
  createdBy: "c",
  customer: { firstname: "Ada" },
  grossAmountMinor: 12100,
  lineItems: [
    {
      booking: "b",
      product: "p",
      description: "Open studio",
      quantity: 1,
      netAmountMinor: 10000,
      grossAmountMinor: 12100,
      taxAmountMinor: 2100,
      locationIds: ["l"],
    },
  ],
};
const revenue = (orders: any[], bookings: any[]) =>
  calculateConfirmedServiceRevenue({
    orders,
    bookings,
    ...periods,
    currency: "CZK",
    locationIds: ["l"],
  });

describe("management calendar comparisons", () => {
  it("compares month-to-date with equal elapsed calendar days and clips shorter months", () => {
    expect(periods.current.from).toBe("2026-11-01");
    expect(periods.comparison.to).toBe("2026-10-07");
    const march = resolveManagementPeriods(
      "2026-03-31",
      "Europe/Prague",
      new Date("2026-04-01T12:00:00Z"),
    );
    expect(march.comparison.to).toBe("2026-02-28");
    expect(march.current.endExclusive.toISOString()).toBe(
      "2026-03-31T22:00:00.000Z",
    );
    expect(march.arrivals.endExclusive.toISOString()).toBe(
      "2026-03-31T22:00:00.000Z",
    );
  });
  it("does not divide by zero or turn unavailable data into zero", () => {
    expect(managementKpi(12, 0).changePercent).toBeNull();
    expect(managementKpi(0, 0).changePercent).toBe(0);
    expect(managementKpi(null, 4)).toEqual({
      value: null,
      previous: 4,
      changePercent: null,
    });
  });
});

describe("management service recognition", () => {
  it("recognizes only explicit completed service net snapshots on the service end date", () => {
    expect(revenue([order], [booking]).totals.current).toBe(10000);
    expect(
      revenue([order], [{ ...booking, paymentStatus: "PENDING_PAYMENT" }])
        .totals.current,
    ).toBe(10000);
    expect(
      revenue([{ ...order, paidAt: "2026-10-01" }], [booking]).totals.current,
    ).toBe(10000);
    expect(
      revenue([order], [{ ...booking, status: "delivered" }]).totals.current,
    ).toBe(0);
    expect(
      revenue([order], [{ ...booking, end: "2026-12-01" }]).totals.current,
    ).toBe(0);
  });
  it("excludes discounts, refunds, credits and location/currency mismatches from the supported subtotal", () => {
    for (const changed of [
      { ...order, currency: "EUR" },
      { ...order, appliedDiscount: { amountMinor: 1000 } },
      { ...order, grossAmountMinor: 10000 },
      { ...order, membershipRedemption: { membershipId: "m" } },
      { ...order, courseCancellations: [{ bookingId: "b" }] },
      {
        ...order,
        lineItems: [{ ...order.lineItems[0], locationIds: ["other"] }],
      },
    ])
      expect(revenue([changed], [booking]).totals.current).toBe(0);
  });
});

describe("management operational counting", () => {
  it("excludes removed attendees, anonymous guests from unique clients, and the class instructor", () => {
    const row = {
      tag: "class",
      createdBy: "instructor",
      attendanceManaged: true,
      numberOfGuests: 20,
      participants: [
        { customer: "customer", name: "Ada" },
        { customer: "removed", attendanceStatus: "removed" },
        { name: "Guest" },
      ],
    };
    expect(managementParticipantCount(row)).toBe(2);
    expect(managementBookingCustomers(row)).toEqual([
      { id: "customer", name: "Ada" },
    ]);
  });
});
