import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ membership: vi.fn() }));
vi.mock("@/modules/membership/membership.repository.js", () => ({ membershipRepository: { findActiveUserMembership: mocks.membership } }));
import { resolveCheckoutMembershipAllowance } from "@/modules/checkout/services/checkout.membership-allowance.service.js";

const item = { product: { _id: "product", type: "public-workshop" }, locationId: "grohova", numberOfGuests: 1, start: "2026-11-10T09:00:00Z", end: "2026-11-10T10:30:00Z" };
const product = { _id: "product", type: "public-workshop", kind: "open-studio", bookingMode: "public" };
const run = (cartItems = [item], dbProduct = product) => resolveCheckoutMembershipAllowance({ tenantId: "tenant", userId: "member", benefitKey: "hours", cartItems, productById: new Map([["product", dbProduct]]), totalAmountMinor: 30000, currency: "CZK" });
describe("personal membership booking redemption", () => {
  const activeMembership = () => ({ status: "active", currentPeriodStart: "2026-11-01T00:00:00Z", currentPeriodEnd: "2026-12-01T00:00:00Z", planSnapshot: { locationScope: { type: "shared_selected", locationIds: ["grohova", "vaclavska"] }, benefits: [{ key: "hours", type: "allowance", unit: "minute", usageScope: "open_studio", memberOnly: true }] } });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    mocks.membership.mockResolvedValue(activeMembership());
  });
  afterEach(() => { vi.useRealTimers(); });
  it("derives 90 consumed minutes from the server product and booking duration at either included studio", async () => {
    expect(await run()).toEqual({ quantity: 90, bookingContext: { productKind: "open_studio", bookingMode: "public", participantCount: 1, durationMinutes: 90 } });
    expect((await run([{ ...item, locationId: "vaclavska" }])).quantity).toBe(90);
  });
  it("rejects companions and mixed carts instead of spending one member's hours for everyone", async () => {
    await expect(run([{ ...item, numberOfGuests: 2 }])).rejects.toMatchObject({ code: "MEMBERSHIP_MEMBER_ONLY" });
    await expect(run([item, item])).rejects.toMatchObject({ code: "MEMBERSHIP_PERSONAL_BOOKING_REQUIRED" });
  });
  it("uses the persisted product to reject a forged course or private booking", async () => {
    await expect(run([item], { ...product, type: "public-course", kind: "class" })).rejects.toMatchObject({ code: "MEMBERSHIP_OPEN_STUDIO_ONLY" });
    await expect(run([item], { ...product, bookingMode: "private" })).rejects.toMatchObject({ code: "MEMBERSHIP_OPEN_STUDIO_ONLY" });
  });
  it("rejects a third location and invalid durations", async () => {
    await expect(run([{ ...item, locationId: "another" }])).rejects.toMatchObject({ code: "MEMBERSHIP_LOCATION_NOT_ALLOWED" });
    await expect(run([{ ...item, end: item.start }])).rejects.toMatchObject({ code: "MEMBERSHIP_BOOKING_DURATION_INVALID" });
  });
  it("does not consume expiring hours for a visit in a later period or crossing renewal", async () => {
    await expect(run([{ ...item, start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" }])).rejects.toMatchObject({ code: "MEMBERSHIP_OUTSIDE_PAID_PERIOD" });
    await expect(run([{ ...item, start: "2026-11-30T23:30:00Z", end: "2026-12-01T00:30:00Z" }])).rejects.toMatchObject({ code: "MEMBERSHIP_OUTSIDE_PAID_PERIOD" });
  });
  it.each(["pending", "past_due", "paused", "cancelled", "expired"])("rejects direct allowance checkout for %s memberships", async (status) => {
    mocks.membership.mockResolvedValue({ ...activeMembership(), status });
    await expect(run()).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });
  });
  it.each([
    { currentPeriodStart: null },
    { currentPeriodEnd: null },
    { currentPeriodStart: "invalid" },
    { currentPeriodStart: "2026-11-05T00:00:00Z" },
    { currentPeriodEnd: "2026-11-04T12:00:00Z" },
  ])("rejects direct checkout without a current paid term: %j", async (period) => {
    mocks.membership.mockResolvedValue({ ...activeMembership(), ...period });
    await expect(run()).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_ACTIVE" });
  });
  it("allows cancellation scheduled at the end of a current paid period", async () => {
    mocks.membership.mockResolvedValue({ ...activeMembership(), status: "cancel_scheduled" });
    await expect(run()).resolves.toMatchObject({ quantity: 90 });
  });
});
