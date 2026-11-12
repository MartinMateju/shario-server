import { describe, expect, it } from "vitest";

import {
  buildDailyBriefingAttention,
  buildDailyBriefingSuggestedActions,
  buildDeterministicBriefingNarrative,
  createDailyBriefingAccessFingerprint,
  createDailyBriefingScopeKey,
  createDailyBriefingSnapshotHash,
  extractDailyBriefingMetrics,
  localDateKey,
  normalizeDailyBriefingTimezone,
  orderDailyBriefingAttention,
} from "@/modules/ai/services/briefing-snapshot.service.js";

const operations = (overrides: Record<string, unknown> = {}) => ({
  coverage: {
    available: [
      "bookings",
      "tasks",
      "staffPlanning",
      "inventory",
      "firings",
      "communications",
      "orders",
    ],
    unavailable: [],
    complete: true,
  },
  bookings: { todayCount: 12, unpaidCount: 2, occupancyPercent: 75 },
  tasks: { openCount: 7, overdueCount: 2, urgent: 1 },
  staffPlanning: {
    counts: { missing: 1, blocked: 0, needsOwnerAttention: 1 },
  },
  inventory: { lowStockCount: 3 },
  firings: {
    readyToFire: 4,
    readyForPickup: 5,
    running: 2,
    pending: 1,
    completedAwaitingNotification: 2,
  },
  communications: { open: 6, urgent: 1, unread: 4 },
  orders: {
    paidToday: 9,
    totalsMinorByCurrency: { czk: 125_000, eur: 300 },
  },
  ...overrides,
});

describe("daily briefing verified snapshot", () => {
  it("keeps unavailable source values null instead of turning them into zero", () => {
    const metrics = extractDailyBriefingMetrics(
      operations({
        coverage: {
          available: ["bookings"],
          unavailable: [
            { source: "tasks", reason: "permission" },
            { source: "orders", reason: "module" },
          ],
          complete: false,
        },
      }),
    );

    expect(metrics.bookingsToday).toBe(12);
    expect(metrics.openTasks).toBeNull();
    expect(metrics.paidOrdersToday).toBeNull();
    expect(metrics.paidTotalsMinorByCurrency).toBeNull();
    expect(metrics.coverage).toEqual({
      available: ["bookings"],
      unavailable: ["orders", "tasks"],
      complete: false,
    });
    expect(metrics.sourceCount).toBe(1);
  });

  it("normalizes exact operational metrics without inventing missing fields", () => {
    const metrics = extractDailyBriefingMetrics(
      operations({
        bookings: { todayCount: 0 },
        orders: {
          paidToday: 0,
          totalsMinorByCurrency: { usd: "1250", broken: "unknown" },
        },
      }),
    );

    expect(metrics.bookingsToday).toBe(0);
    expect(metrics.unpaidBookings).toBeNull();
    expect(metrics.occupancyPercent).toBeNull();
    expect(metrics.paidOrdersToday).toBe(0);
    expect(metrics.paidTotalsMinorByCurrency).toEqual({ USD: 1250 });
  });

  it("reads the operational builder's bounded unpaid-future total", () => {
    const metrics = extractDailyBriefingMetrics(
      operations({
        bookings: {
          todayCount: 4,
          unpaidFuture: {
            bookings: { items: [], total: 6, truncated: false },
          },
        },
      }),
    );

    expect(metrics.unpaidBookings).toBe(6);
  });

  it("builds ordered, allowlisted findings and fully Czech fallback copy", () => {
    const metrics = extractDailyBriefingMetrics(operations());
    const attention = buildDailyBriefingAttention(metrics, "cs-CZ");
    const narrative = buildDeterministicBriefingNarrative(
      metrics,
      attention,
      "cs-CZ",
    );
    const ordered = orderDailyBriefingAttention(attention, [
      "low-stock-items",
      "model-invented-id",
      "low-stock-items",
    ]);

    expect(attention.map(({ id }) => id)).toEqual([
      "urgent-conversations",
      "overdue-tasks",
      "urgent-tasks",
      "unpaid-bookings",
      "low-stock-items",
      "staff-updates-owner-attention",
    ]);
    expect(ordered[0].id).toBe("low-stock-items");
    expect(ordered).toHaveLength(attention.length);
    expect(narrative.headline).toContain("prověřit");
    expect(narrative.summary).toContain("rezervac");
    expect(narrative.summary).not.toMatch(/available|booking|task/i);
  });

  it("surfaces reported staff blockers as critical briefing attention", () => {
    const attention = buildDailyBriefingAttention(
      extractDailyBriefingMetrics(
        operations({
          staffPlanning: {
            counts: { missing: 0, blocked: 2, needsOwnerAttention: 0 },
          },
        }),
      ),
      "en",
    );
    const blocker = attention.find(({ id }) => id === "blocked-staff-updates");

    expect(blocker).toMatchObject({
      key: "blocked_staff_updates",
      severity: "critical",
      metricKey: "blockedStaffUpdates",
      value: 2,
      title: "Staff blockers",
      href: "/app/operations?section=tasks",
    });
    expect(blocker?.description).toContain(
      "2 staff updates reporting blockers",
    );
    expect(attention.indexOf(blocker!)).toBeLessThan(
      attention.findIndex(({ id }) => id === "urgent-tasks"),
    );
  });

  it("uses authorized staff detail without duplicating an owner-attention blocker", () => {
    const metrics = extractDailyBriefingMetrics(
      operations({
        staffPlanning: {
          counts: { missing: 0, blocked: 0, needsOwnerAttention: 1 },
          today: {
            staff: {
              total: 1,
              truncated: false,
              items: [
                {
                  displayName: "Maya",
                  update: {
                    blockers: "Waiting for kiln repair approval.",
                    needsOwnerAttention: true,
                  },
                },
              ],
            },
          },
        },
      }),
    );
    const attention = buildDailyBriefingAttention(metrics, "en");

    expect(metrics.blockedStaffUpdates).toBe(1);
    expect(metrics.staffUpdatesNeedingOwnerAttention).toBe(0);
    expect(
      attention.filter(({ id }) => id === "blocked-staff-updates"),
    ).toHaveLength(1);
    expect(
      attention.some(({ id }) => id === "staff-updates-owner-attention"),
    ).toBe(false);
  });

  it("returns navigation and assistant intents, never executable command payloads", () => {
    const attention = buildDailyBriefingAttention(
      extractDailyBriefingMetrics(operations()),
      "en",
    );
    const actions = buildDailyBriefingSuggestedActions(attention, "en");

    expect(actions[0]).toMatchObject({
      id: "review-daily-briefing",
      kind: "assistant_intent",
      intent: "review-daily-briefing",
    });
    expect(
      actions.every(({ kind }) =>
        ["assistant_intent", "navigate"].includes(kind),
      ),
    ).toBe(true);
    expect(JSON.stringify(actions)).not.toContain("payload");
    expect(
      actions.filter(({ href }) => href === "/app/operations?section=tasks"),
    ).toHaveLength(1);
  });

  it("uses a stable bounded scope key for large restricted location sets", () => {
    const locationIds = Array.from({ length: 30 }, (_, index) =>
      `${index}`.padStart(24, "0"),
    );
    const first = createDailyBriefingScopeKey({
      allowedLocationIds: locationIds,
    });
    const second = createDailyBriefingScopeKey({
      allowedLocationIds: [...locationIds].reverse(),
    });

    expect(first).toBe(second);
    expect(first.length).toBeLessThan(80);
    expect(
      createDailyBriefingScopeKey({
        locationId: locationIds[0],
        allowedLocationIds: locationIds,
      }),
    ).toBe(`location:${locationIds[0]}`);
  });

  it("invalidates cache identity when permissions, modules or locale-backed facts change", () => {
    const base = {
      access: {
        accessVersion: 4,
        permissions: ["ai.use", "bookings.view"],
        locationAccess: { mode: "all" },
      },
      allowedLocationIds: null,
      modules: { bookings: true, inventory: true },
      contextVersion: "studio-context-v1",
    };
    const fingerprint = createDailyBriefingAccessFingerprint(base);
    const changedPermission = createDailyBriefingAccessFingerprint({
      ...base,
      access: {
        ...base.access,
        accessVersion: 5,
        permissions: ["ai.use"],
      },
    });
    const changedModule = createDailyBriefingAccessFingerprint({
      ...base,
      modules: { bookings: true, inventory: false },
    });
    const metrics = extractDailyBriefingMetrics(operations());
    const attention = buildDailyBriefingAttention(metrics, "en");
    const hash = createDailyBriefingSnapshotHash({
      dateKey: "2026-08-03",
      timezone: "Europe/Prague",
      locale: "en",
      accessFingerprint: fingerprint,
      metrics,
      attention,
    });
    const czechHash = createDailyBriefingSnapshotHash({
      dateKey: "2026-08-03",
      timezone: "Europe/Prague",
      locale: "cs",
      accessFingerprint: fingerprint,
      metrics,
      attention: buildDailyBriefingAttention(metrics, "cs"),
    });

    expect(changedPermission).not.toBe(fingerprint);
    expect(changedModule).not.toBe(fingerprint);
    expect(czechHash).not.toBe(hash);
  });

  it("computes the tenant-local day across UTC midnight and DST", () => {
    expect(
      localDateKey(new Date("2026-03-28T23:30:00.000Z"), "Europe/Prague"),
    ).toBe("2026-03-29");
    expect(
      localDateKey(new Date("2026-10-25T22:30:00.000Z"), "Europe/Prague"),
    ).toBe("2026-10-25");
    expect(normalizeDailyBriefingTimezone("Not/A-Timezone")).toBe("UTC");
    expect(
      localDateKey(new Date("2026-03-28T23:30:00.000Z"), "Not/A-Timezone"),
    ).toBe("2026-03-28");
  });
});
