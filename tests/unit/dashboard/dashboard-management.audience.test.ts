import { describe, expect, it } from "vitest";
import {
  managementActiveCustomerIds,
  managementSubscriberCounts,
} from "@/modules/dashboard/dashboard-management.audience.js";
import { resolveManagementPeriods } from "@/modules/dashboard/dashboard-management.calculations.js";

const now = new Date("2026-11-08T12:00:00Z");
const periods = resolveManagementPeriods("2026-11-08", "Europe/Prague", now);
const studioBooking = (createdBy: string, extra: Record<string, unknown> = {}) => ({
  createdBy, tag: "open-studio", status: "processed", paymentStatus: "CONFIRMED",
  createdAt: "2026-11-04T10:00:00Z", start: "2027-01-01T10:00:00Z", ...extra,
});
const membership = (user: string, extra: Record<string, unknown> = {}) => ({
  user, status: "active", startedAt: "2026-11-02", currentPeriodStart: "2026-11-02",
  currentPeriodEnd: "2026-12-02", ...extra,
});
const activity = (bookings: any[], courseOrders: any[] = [], courseBookings: any[] = []) =>
  managementActiveCustomerIds({ bookings, courseOrders, courseBookings, period: periods.arrivals, asOf: now });

describe("management customer activity", () => {
  it("deduplicates people and counts future visits and later cancellations", () => {
    expect([...activity([
      studioBooking("a"), studioBooking("a"),
      studioBooking("b", { status: "cancelled" }),
    ])]).toEqual(["a", "b"]);
  });
  it("uses creation rather than visit dates with tenant calendar boundaries across DST", () => {
    expect(periods.arrivals.from).toBe("2026-10-10");
    expect(periods.arrivals.start.toISOString()).toBe("2026-10-09T22:00:00.000Z");
    expect([...activity([
      studioBooking("included", { createdAt: periods.arrivals.start }),
      studioBooking("old", { createdAt: new Date(periods.arrivals.start.valueOf() - 1), start: now }),
      studioBooking("future", { createdAt: now }),
      studioBooking("unknown", { createdAt: null }),
      studioBooking("later-confirmation", { paymentConfirmedAt: "2026-12-01" }),
    ])]).toEqual(["included"]);
  });
  it("excludes instructors, drafts and expired holds", () => {
    expect(activity([
      studioBooking("teacher", { tag: "class" }),
      studioBooking("draft", { status: "pending" }),
      studioBooking("expired", { status: "cancelled", paymentStatus: "EXPIRED" }),
      studioBooking("", {}),
    ]).size).toBe(0);
  });
  it("uses completed course reservation creation and verifies its studio class identity", () => {
    const order = {
      createdBy: "a", createdAt: "2026-11-04", isPaid: true, status: "processed_order",
      courseBookings: [{ bookingId: "class-a", quantity: 2 }],
    };
    expect([...activity([studioBooking("a")], [
      order,
      { ...order, createdBy: "b", status: "cancelled_order" },
      { ...order, createdBy: "draft", isPaid: false },
      { ...order, createdBy: "empty", courseBookings: [] },
      { ...order, createdBy: "outside", courseBookings: [{ bookingId: "other-studio", quantity: 1 }] },
      { ...order, createdBy: "later-payment", paidAt: "2026-12-01" },
    ], [{ _id: "class-a", tag: "class", createdBy: "teacher", createdAt: "2025-01-01" }])])
      .toEqual(["a", "b"]);
  });
  it("does not backdate later confirmations into the previous 30-day comparison cohort", () => {
    const comparison = periods.activeCustomerComparison;
    const result = managementActiveCustomerIds({
      bookings: [studioBooking("late-studio", {
        createdAt: "2026-10-08T12:00:00Z", paymentConfirmedAt: "2026-10-09T12:00:00Z",
      })],
      courseOrders: [{
        createdBy: "late-course", createdAt: "2026-10-08T12:00:00Z", paidAt: "2026-10-09T12:00:00Z",
        isPaid: true, status: "processed_order", courseBookings: [{ bookingId: "class", quantity: 1 }],
      }],
      courseBookings: [{ _id: "class", tag: "class" }], period: comparison, asOf: now,
    });
    expect(result.size).toBe(0);
  });
});

describe("management subscriber identities", () => {
  const count = (memberships: any[]) => managementSubscriberCounts({
    memberships, period: periods.current, asOf: now, currentSnapshot: true,
  });
  it("counts subscribers once and retains cancellation-scheduled entitlements until expiry", () => {
    expect(count([
      membership("a"), membership("a"), membership("b", { status: "cancel_scheduled" }),
      membership("expired", { currentPeriodEnd: now }),
      membership("paused", { status: "paused" }),
      membership("unpaid", { status: "past_due" }),
    ]).active).toBe(2);
  });
  it("finds first recorded activation across old expired memberships and ignores renewals and returns", () => {
    expect(count([
      membership("new"), membership("new"),
      membership("renewed", { startedAt: "2025-01-01" }),
      membership("returning", { status: "expired", startedAt: "2024-01-01", currentPeriodEnd: "2024-02-01" }),
      membership("returning"),
      membership("pending", { status: "pending", startedAt: null }),
      membership("future", { startedAt: "2026-12-01" }),
    ]).newSubscribers).toBe(1);
  });
  it("returns unavailable when identities or historical activation dates are missing", () => {
    expect(count([membership("", {})])).toEqual({ active: null, newSubscribers: null });
    expect(count([membership("a", { status: "expired", startedAt: null })]).newSubscribers).toBeNull();
  });
  it("ignores abandoned and failed initial checkouts while keeping real history uncertainty unavailable", () => {
    const abandoned = ["expired", "cancelled", "past_due", "paused"].map((status) => ({
      user: status, status, startedAt: null, currentPeriodStart: null,
      currentPeriodEnd: null, assignmentSource: "checkout",
    }));
    expect(count([...abandoned, membership("new")])).toEqual({ active: 1, newSubscribers: 1 });
    expect(count([...abandoned, membership("uncertain", {
      startedAt: null, status: "expired", assignmentSource: "checkout",
    })]).newSubscribers).toBeNull();
  });
  it("never reconstructs historical active counts from the current status", () => {
    expect(managementSubscriberCounts({
      memberships: [membership("a")], period: periods.current, asOf: now, currentSnapshot: false,
    })).toEqual({ active: null, newSubscribers: 1 });
  });
});
