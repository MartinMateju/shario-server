import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ membership: vi.fn(), balances: vi.fn() }));
vi.mock("@/modules/membership/membership.repository.js", () => ({
  membershipRepository: { findActiveUserMembership: mocks.membership },
}));
vi.mock("@/modules/membership/membership-entitlement-balance.schema.js", () => ({
  default: { find: mocks.balances },
}));

import { getCartMembershipPaymentOptions } from "@/modules/checkout/services/checkout.membership-options.service.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const PERIOD_END = new Date("2026-12-01T00:00:00Z");
const benefit = {
  key: "hours", label: "Studio hours", type: "allowance", unit: "minute",
  usageScope: "open_studio", memberOnly: true,
};
const product = {
  _id: "product", type: "public-workshop", kind: "open-studio", bookingMode: "public",
};
const item = {
  product: { _id: "product", type: "public-workshop" },
  locationId: "grohova", numberOfGuests: 1,
  start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:30:00Z",
};
const membership = (overrides: Record<string, unknown> = {}) => ({
  _id: "membership", status: "active",
  currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
  currentPeriodEnd: PERIOD_END,
  planSnapshot: {
    locationScope: { type: "shared_selected", locationIds: ["grohova", "vaclavska"] },
    benefits: [benefit],
  },
  ...overrides,
});
const setBalances = (balances: any[]) => {
  mocks.balances.mockReturnValue({ lean: () => ({ exec: async () => balances }) });
};
const run = (overrides: Record<string, unknown> = {}) => getCartMembershipPaymentOptions({
  tenantId: "tenant", userId: "member", cartItems: [item],
  productById: new Map([["product", product]]), totalAmountMinor: 30000, currency: "CZK",
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.membership.mockResolvedValue(membership());
  setBalances([{ benefitKey: "hours", available: 180, expiresAt: PERIOD_END }]);
});
afterEach(() => { vi.useRealTimers(); });

describe("cart membership payment quote", () => {
  it("offers included hours from the actual booking duration and both allowed studios", async () => {
    await expect(run()).resolves.toEqual([{
      method: "membership_credits", benefitKey: "hours", label: "Studio hours",
      unit: "minute", required: 90, available: 180, coversTotal: true,
    }]);
    await expect(run({ cartItems: [{ ...item, locationId: "vaclavska", quantity: 1 }] }))
      .resolves.toEqual([expect.objectContaining({ required: 90, coversTotal: true })]);
    expect(mocks.membership).toHaveBeenCalledWith("tenant", "member");
    expect(mocks.balances).toHaveBeenCalledWith({
      tenant: "tenant", user: "member", membership: "membership",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: NOW } }],
    });
  });

  it("keeps insufficient or exhausted hours visible without offering redemption", async () => {
    for (const available of [89, 0]) {
      setBalances([{ benefitKey: "hours", available, expiresAt: PERIOD_END }]);
      await expect(run()).resolves.toEqual([expect.objectContaining({
        required: 90, available, coversTotal: false,
        unavailableReason: "membership_insufficient_hours",
      })]);
    }
    setBalances([]);
    await expect(run()).resolves.toEqual([expect.objectContaining({ available: 0, coversTotal: false })]);
  });

  it("quotes only unexpired time buckets, matching redemption's usable balance", async () => {
    setBalances([{
      benefitKey: "hours", available: 180, expiresAt: PERIOD_END, timeBucketVersion: 1,
      timeBuckets: [
        { kind: "carryover", available: 120, expiresAt: NOW },
        { kind: "period", available: 60, expiresAt: PERIOD_END },
      ],
    }]);
    await expect(run()).resolves.toEqual([expect.objectContaining({
      required: 90, available: 60, coversTotal: false,
      unavailableReason: "membership_insufficient_hours",
    })]);
  });

  it.each([
    { label: "course", dbProduct: { ...product, type: "public-course", kind: "class" } },
    { label: "private hire", dbProduct: { ...product, bookingMode: "private" } },
  ])("rejects $label using the persisted product, even when the cart claims shared studio", async ({ dbProduct }) => {
    await expect(run({ productById: new Map([["product", dbProduct]]) }))
      .resolves.toEqual([expect.objectContaining({ coversTotal: false, unavailableReason: "membership_open_studio_only" })]);
  });

  it.each([
    { label: "companion count", cartItems: [{ ...item, numberOfGuests: 2 }], reason: "membership_member_only" },
    { label: "guest details", cartItems: [{ ...item, guests: [{ firstname: "Guest" }] }], reason: "membership_member_only" },
    { label: "mixed cart", cartItems: [item, item], reason: "membership_personal_booking_required" },
    { label: "third studio", cartItems: [{ ...item, locationId: "another" }], reason: "membership_location_not_allowed" },
    { label: "booking extension", cartItems: [{ ...item, bookingExtension: { amountMinor: 5000 } }], reason: "membership_open_studio_only" },
    { label: "later period", cartItems: [{ ...item, start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:30:00Z" }], reason: "membership_outside_paid_period" },
    { label: "crossing renewal", cartItems: [{ ...item, start: "2026-11-30T23:30:00Z", end: "2026-12-01T00:30:00Z" }], reason: "membership_outside_paid_period" },
  ])("does not offer member hours for $label", async ({ cartItems, reason }) => {
    await expect(run({ cartItems })).resolves.toEqual([
      expect.objectContaining({ coversTotal: false, unavailableReason: reason }),
    ]);
  });

  it.each(["pending", "past_due", "paused", "cancelled", "expired"])(
    "does not offer allowances for a %s membership", async (status) => {
      mocks.membership.mockResolvedValue(membership({ status }));
      await expect(run()).resolves.toEqual([]);
      expect(mocks.balances).not.toHaveBeenCalled();
    },
  );

  it("retains access through a paid cancellation period", async () => {
    mocks.membership.mockResolvedValue(membership({ status: "cancel_scheduled" }));
    await expect(run()).resolves.toEqual([expect.objectContaining({ coversTotal: true })]);
  });

  it.each([
    { currentPeriodStart: null },
    { currentPeriodEnd: null },
    { currentPeriodStart: new Date("invalid") },
    { currentPeriodStart: new Date("2026-11-05T00:00:00Z") },
    { currentPeriodEnd: NOW },
  ])("requires a current, established paid period: %j", async (period) => {
    mocks.membership.mockResolvedValue(membership(period));
    await expect(run()).resolves.toEqual([]);
    expect(mocks.balances).not.toHaveBeenCalled();
  });

  it("does not silently spend an unsupported allowance or informational benefit", async () => {
    const current = membership();
    mocks.membership.mockResolvedValue({ ...current, planSnapshot: {
      ...current.planSnapshot,
      benefits: [
        { ...benefit, key: "credits", unit: "credit" },
        { key: "course_discount", type: "percentage", percentageBps: 1000, appliesTo: "products" },
        { key: "coffee", type: "boolean", enabled: true },
      ],
    } });
    await expect(run()).resolves.toEqual([]);
  });

  it("requires the checkout currency for monetary allowances", async () => {
    const current = membership();
    mocks.membership.mockResolvedValue({ ...current, planSnapshot: {
      ...current.planSnapshot,
      benefits: [{ key: "balance", type: "allowance", unit: "money_minor", currency: "EUR" }],
    } });
    setBalances([{ benefitKey: "balance", available: 999999, expiresAt: PERIOD_END }]);
    await expect(run()).resolves.toEqual([expect.objectContaining({
      coversTotal: false, unavailableReason: "membership_entitlement_currency_mismatch",
    })]);
  });

  it("propagates database failures instead of quoting full price as if membership did not exist", async () => {
    const failure = Object.assign(new Error("Database unavailable"), { code: "ECONNRESET" });
    mocks.membership.mockResolvedValueOnce(membership()).mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
  });

  it("returns no options when the customer has no membership", async () => {
    mocks.membership.mockResolvedValue(null);
    await expect(run()).resolves.toEqual([]);
    expect(mocks.balances).not.toHaveBeenCalled();
  });
});
