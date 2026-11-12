import { describe, expect, it } from "vitest";

import {
  buildBusinessAdvisorRecommendations,
  createBusinessAdvisorAccessFingerprint,
  isGroundedBusinessAdvisorNarrative,
  orderBusinessAdvisorRecommendations,
  resolveBusinessAdvisorStatus,
} from "@/modules/ai/services/business-advisor-snapshot.service.js";

const overview = (overrides: Record<string, any> = {}) => ({
  metadata: {
    period: { from: "2026-07-06", to: "2026-08-02" },
    comparisonPeriod: { from: "2026-06-08", to: "2026-07-05" },
    timezone: "Europe/Prague",
    currency: "CZK",
    locationId: "507f1f77bcf86cd799439013",
  },
  coverage: {
    available: [
      "sales",
      "bookings",
      "customers",
      "courses",
      "inventory",
      "staffTasks",
      "firings",
    ],
    unavailable: [],
    limitations: [],
    complete: true,
  },
  summary: {
    netSales: { value: 70_000, previous: 100_000, changePercent: -30 },
    bookings: { value: 70, previous: 100, changePercent: -30 },
    utilizationPercent: { value: 20, previous: 35, changePercent: -42.86 },
    returningCustomerPercent: {
      value: 30,
      previous: 45,
      changePercent: -33.33,
    },
  },
  sales: { orders: 30 },
  bookings: {
    total: 70,
    courseFill: [
      {
        productId: "507f1f77bcf86cd799439020",
        name: "Wheel basics",
        sessions: 5,
        bookedSeats: 10,
        capacity: 50,
        fillPercent: 20,
      },
      {
        productId: "507f1f77bcf86cd799439021",
        name: "Glazing",
        sessions: 5,
        bookedSeats: 45,
        capacity: 50,
        fillPercent: 90,
      },
    ],
  },
  customers: { active: 50 },
  operations: {
    inventory: { lowStockItems: 6, openReorders: 1 },
    staffTasks: { open: 20, overdue: 6, completionRatePercent: 60 },
    firings: { registeredPiecesAwaitingPickup: 4 },
  },
  ...overrides,
});

describe("Business Advisor deterministic snapshot", () => {
  it("emits at most five priority-ordered cards from conservative signals", () => {
    const cards = buildBusinessAdvisorRecommendations(overview(), "en");

    expect(cards).toHaveLength(5);
    expect(cards.every(({ id }) => /^adv_[a-f0-9]{24}$/.test(id))).toBe(true);
    expect(cards[0]?.priority).toBe("high");
    expect(cards.map(({ key }) => key)).toContain("revenue.net_sales_decline");
    expect(cards.map(({ key }) => key)).toContain("capacity.booking_decline");
    expect(cards[0]?.href).toContain(
      "/app/operations?section=statistics&reportTab=",
    );
    expect(cards[0]?.href).toContain("from=2026-07-06");
    expect(cards[0]?.href).toContain("to=2026-08-02");
    expect(cards[0]?.href).toContain("locationId=507f1f77bcf86cd799439013");
    expect(resolveBusinessAdvisorStatus(overview(), cards)).toBe("ready");
  });

  it("does not emit trend advice below minimum samples", () => {
    const facts = overview({
      sales: { orders: 9 },
      bookings: { total: 9, courseFill: [] },
      customers: { active: 19 },
      operations: { inventory: null, staffTasks: null, firings: null },
      summary: {
        netSales: { value: 1, previous: 100_000, changePercent: -99 },
        bookings: { value: 9, previous: 100, changePercent: -91 },
        utilizationPercent: { value: 1, previous: 80, changePercent: -98 },
        returningCustomerPercent: {
          value: 1,
          previous: 80,
          changePercent: -98,
        },
      },
    });

    const cards = buildBusinessAdvisorRecommendations(facts, "en");
    expect(cards).toEqual([]);
    expect(resolveBusinessAdvisorStatus(facts, cards)).toBe("learning");
  });

  it("does not label point-in-time operational evidence as a period metric", () => {
    const facts = overview({
      summary: {
        netSales: { value: null, previous: null, changePercent: null },
        bookings: { value: null, previous: null, changePercent: null },
        utilizationPercent: {
          value: null,
          previous: null,
          changePercent: null,
        },
        returningCustomerPercent: {
          value: null,
          previous: null,
          changePercent: null,
        },
      },
      sales: { orders: 0 },
      bookings: { total: 0, courseFill: [] },
      customers: { active: 0 },
      operations: {
        inventory: { lowStockItems: 4, openReorders: 0 },
        staffTasks: null,
        firings: null,
      },
    });

    const [card] = buildBusinessAdvisorRecommendations(facts, "en");
    expect(card?.key).toBe("inventory.uncovered_low_stock");
    expect(card?.evidence.every(({ period }) => period === null)).toBe(true);
  });

  it("requires comparative retention evidence and robust course samples", () => {
    const facts = overview({
      summary: {
        netSales: { value: null, previous: null, changePercent: null },
        bookings: { value: 40, previous: 40, changePercent: 0 },
        utilizationPercent: { value: 50, previous: 50, changePercent: 0 },
        returningCustomerPercent: {
          value: 10,
          previous: null,
          changePercent: null,
        },
      },
      sales: { orders: 0 },
      bookings: {
        total: 40,
        courseFill: [
          {
            productId: "507f1f77bcf86cd799439020",
            name: "Too little evidence",
            sessions: 2,
            capacity: 100,
            fillPercent: 5,
          },
        ],
      },
      customers: { active: 100 },
      operations: {},
    });

    expect(buildBusinessAdvisorRecommendations(facts, "en")).toEqual([]);
    facts.summary.returningCustomerPercent.previous = 30;
    expect(
      buildBusinessAdvisorRecommendations(facts, "en").map(({ key }) => key),
    ).toEqual(["retention.returning_customers"]);
    expect(
      buildBusinessAdvisorRecommendations(facts, "en")[0]?.confidence,
    ).toBe("medium");
    facts.summary.returningCustomerPercent.value = 80;
    facts.summary.returningCustomerPercent.previous = 95;
    expect(buildBusinessAdvisorRecommendations(facts, "en")).toEqual([]);
  });

  it("never lets provider ordering cross deterministic priority bands", () => {
    const cards = buildBusinessAdvisorRecommendations(overview(), "en");
    const high = cards.find(({ priority }) => priority === "high")!;
    const medium = cards.find(({ priority }) => priority === "medium")!;
    const requested = [medium.id, high.id, ...cards]
      .map((entry) => (typeof entry === "string" ? entry : entry.id))
      .filter((id, index, all) => all.indexOf(id) === index);

    const ordered = orderBusinessAdvisorRecommendations(cards, requested);
    expect(ordered.indexOf(high)).toBeLessThan(ordered.indexOf(medium));
    expect(
      isGroundedBusinessAdvisorNarrative(
        {
          headline: "Review the evidence",
          summary: "Start with the verified priorities.",
          rankedRecommendationIds: requested,
        },
        cards,
        {},
      ),
    ).toBe(false);
  });

  it("rejects forged ids, unsupported numbers and causal claims", () => {
    const cards = buildBusinessAdvisorRecommendations(overview(), "en");
    const ids = cards.map(({ id }) => id);
    const base = {
      headline: "Review the verified signals",
      summary: "Prioritize reversible tests.",
      rankedRecommendationIds: ids,
    };

    expect(isGroundedBusinessAdvisorNarrative(base, cards, {})).toBe(true);
    expect(
      isGroundedBusinessAdvisorNarrative(
        { ...base, summary: "Revenue will improve by 999%." },
        cards,
        {},
      ),
    ).toBe(false);
    expect(
      isGroundedBusinessAdvisorNarrative(
        {
          ...base,
          rankedRecommendationIds: [
            ...ids.slice(0, -1),
            "adv_aaaaaaaaaaaaaaaaaaaaaaaa",
          ],
        },
        cards,
        {},
      ),
    ).toBe(false);
  });

  it("fingerprints current permissions, modules and location scope", () => {
    const base = {
      access: {
        accessVersion: 1,
        role: "owner",
        permissions: ["ai.use", "reports.view"],
        locationAccess: { mode: "all" },
      },
      locationId: null,
      allowedLocationIds: null,
      modules: { ai: true, bookings: true },
      settingsVersion: "2026-08-03T08:00:00.000Z",
    } as const;
    const first = createBusinessAdvisorAccessFingerprint(base);
    const downgraded = createBusinessAdvisorAccessFingerprint({
      ...base,
      access: { ...base.access, permissions: ["ai.use"] },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(downgraded).not.toBe(first);
  });
});
