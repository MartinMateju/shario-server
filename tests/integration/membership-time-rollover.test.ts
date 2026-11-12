import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const webhookMocks = vi.hoisted(() => ({ subscription: vi.fn(), invoice: vi.fn(), notification: vi.fn(), audit: vi.fn() }));
vi.mock("@/modules/membership/membership.stripe.gateway.js", () => ({
  MEMBERSHIP_STRIPE_FLOW: "membership", retrieveMembershipSubscription: webhookMocks.subscription,
}));
vi.mock("@/modules/membership/services/membership-invoice.service.js", () => ({ syncMembershipInvoice: webhookMocks.invoice }));
vi.mock("@/modules/membership/services/membership-notification.service.js", () => ({ enqueueMembershipNotification: webhookMocks.notification }));
vi.mock("@/modules/membership/membership-audit-event.schema.js", () => ({ recordMembershipAudit: webhookMocks.audit }));
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import Balance from "@/modules/membership/membership-entitlement-balance.schema.js";
import Ledger from "@/modules/membership/membership-entitlement-ledger.schema.js";
import {
  grantMembershipPeriodEntitlements, redeemMembershipEntitlement, reverseMembershipRedemption,
  adjustMembershipEntitlement, expireDueMembershipEntitlement, expireMembershipEntitlements,
  appendMembershipImportAdjustment,
} from "@/modules/membership/services/membership-entitlement.service.js";
import { serializeEntitlementBalance } from "@/modules/membership/membership.serializers.js";
import { applyPaymentConfirmed, periodFromPaidMembershipInvoice } from "@/modules/membership/services/membership-webhook.service.js";

const jan = new Date("2026-01-01T00:00:00Z");
const feb = new Date("2026-02-01T00:00:00Z");
const mar = new Date("2026-03-01T00:00:00Z");
const apr = new Date("2026-04-01T00:00:00Z");
const invoiceFor = (start: Date, end: Date) => ({ id: `in_${start.getMonth()}`, subscription: "sub_member", status: "paid",
  lines: { data: [{ type: "subscription", subscription: "sub_member", proration: false,
    period: { start: start.getTime() / 1000, end: end.getTime() / 1000 } }] },
} as any);
const paymentEvent = (id: string, type = "invoice.paid") => ({ id, type, created: Math.floor(Date.now() / 1000),
  data: { object: { id: "in_paid", subscription: "sub_member", customer: "cus_member", invoice: "in_checkout", payment_status: "paid" } },
} as any);
let server: MongoMemoryReplSet;
let membership: any;
const transaction = async <T>(run: (session: mongoose.ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try { return (await session.withTransaction(() => run(session)))!; }
  finally { await session.endSession(); }
};
const createMembership = async (benefit = {}) => UserMembershipModel.create({
  tenant: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId(),
  plan: new mongoose.Types.ObjectId(), planVersion: new mongoose.Types.ObjectId(),
  planSnapshot: { version: 1, name: "Monthly pottery hours", prices: [{ currency: "CZK", amountMinor: 460000 }],
    billing: { type: "recurring", interval: "month", intervalCount: 1 }, locationScope: { type: "all" },
    benefits: [{ key: "studio-time", label: "Studio time", type: "allowance", unit: "minute", quantity: 240,
      usageScope: "open_studio", memberOnly: true, rolloverPercent: 25, adjustable: true, ...benefit }] },
  currency: "CZK", amountMinor: 460000, status: "active", startedAt: jan,
  currentPeriodStart: jan, currentPeriodEnd: feb,
} as any);
const grant = (start: Date, end: Date, key = start.toISOString()) => transaction(async (session) => {
  const granted = await grantMembershipPeriodEntitlements({ membership, periodStart: start, periodEnd: end, periodKey: key, session });
  if (granted) await UserMembershipModel.updateOne({ _id: membership._id },
    { $set: { currentPeriodStart: start, currentPeriodEnd: end } }, { session });
  return granted;
});
const redeem = (quantity: number, key: string) => redeemMembershipEntitlement({
  tenantId: String(membership.tenant), userId: String(membership.user), benefitKey: "studio-time", quantity,
  reference: { type: "booking", id: key }, idempotencyKey: key,
  bookingContext: { productKind: "open_studio", bookingMode: "public", participantCount: 1, durationMinutes: quantity },
});
const reverse = (entry: any, key = `reverse:${entry._id}`) => reverseMembershipRedemption({
  tenantId: String(membership.tenant), membershipId: String(membership._id),
  redemptionEntryId: String(entry._id), reason: "booking_cancelled", idempotencyKey: key,
});
const adjust = (delta: number, key: string) => adjustMembershipEntitlement({
  tenantId: String(membership.tenant), membershipId: String(membership._id), benefitKey: "studio-time", delta,
  reason: "manual_correction", actorId: String(membership.user), idempotencyKey: key,
});
const balance = () => Balance.findOne({ membership: membership._id, benefitKey: "studio-time" }).lean().orFail();
const assertLedgerConsistent = async () => {
  const current = await balance();
  const entries = await Ledger.find({ membership: membership._id }).sort({ sequence: 1 }).lean();
  let total = 0;
  entries.forEach((entry, index) => {
    total += entry.amount;
    expect(entry.balanceAfter).toBe(total);
    expect(entry.sequence).toBe(index + 1);
  });
  expect(current.available).toBe(total);
  expect(current.timeBuckets.reduce((sum, bucket) => sum + bucket.available, 0)).toBe(total);
};

describe("monthly membership time ledger (real Mongo transactions)", () => {
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri(), { dbName: "membership-rollover-test" });
    await Promise.all([UserMembershipModel.init(), Balance.init(), Ledger.init()]);
  }, 60000);
  afterAll(async () => { await mongoose.disconnect(); await server?.stop(); });
  beforeEach(async () => {
    await Promise.all([UserMembershipModel.collection.deleteMany({}), Balance.collection.deleteMany({}), Ledger.collection.deleteMany({})]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-01-10T12:00:00Z");
    membership = await createMembership();
  });

  it("caps carry at 25%, spends it first and never carries the old carry again", async () => {
    await grant(jan, feb);
    await redeem(60, "january-visit");
    vi.setSystemTime("2026-02-01T12:00:00Z");
    expect(await grant(feb, mar)).toBe(true);
    expect(serializeEntitlementBalance(await balance())).toMatchObject({ available: 300,
      currentPeriodAvailable: 240, carryoverAvailable: 60, carryoverExpiresAt: mar.toISOString() });
    const february = await redeem(30, "february-visit");
    expect(february.timeAllocations.map((item: any) => [item.kind, item.amount])).toEqual([["carryover", 30]]);
    vi.setSystemTime("2026-03-01T12:00:00Z");
    await grant(mar, apr);
    expect((await balance()).available).toBe(300); // 30 unused old carry is lost, only 60 of base survives.
    expect(await Ledger.countDocuments({ membership: membership._id, reason: "period_rollover" })).toBe(2);
    await assertLedgerConsistent();
  });

  it("carries only the actual unused current grant when it is below the cap", async () => {
    await grant(jan, feb);
    await redeem(225, "almost-all");
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await grant(feb, mar);
    expect(serializeEntitlementBalance(await balance())).toMatchObject({ available: 255, carryoverAvailable: 15 });
    await assertLedgerConsistent();
  });

  it("preserves carry eligibility when scheduled expiry ran before a delayed consecutive paid renewal", async () => {
    await grant(jan, feb);
    await redeem(60, "visit-before-expiry");
    vi.setSystemTime("2026-02-01T00:00:00Z");
    await transaction((session) => expireDueMembershipEntitlement({ tenantId: String(membership.tenant), membership,
      benefitKey: "studio-time", idempotencyKey: "scheduled-january-expiry", session }));
    expect(await balance()).toMatchObject({ available: 0, rolloverCandidateAvailable: 180 });
    vi.setSystemTime("2026-02-02T12:00:00Z");
    await grant(feb, mar);
    expect((await balance()).available).toBe(300);
    expect(await grant(feb, mar)).toBe(false);
    expect(await grant(feb, mar, "different-invoice-same-period")).toBe(false);
    await assertLedgerConsistent();
  });

  it("does not carry across a missing unpaid month or rewind from out-of-order periods", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-03-01T12:00:00Z");
    await grant(mar, apr);
    expect((await balance()).available).toBe(240);
    expect(await grant(feb, mar, "late-february-invoice")).toBe(false);
    expect(await balance()).toMatchObject({ available: 240, timePeriodStart: mar });
    await assertLedgerConsistent();
  });

  it("restores mixed carry/base cancellation allocations to their original buckets exactly once", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await grant(feb, mar);
    const entry = await redeem(90, "mixed-visit");
    expect(entry.timeAllocations.map((item: any) => [item.kind, item.amount])).toEqual([["carryover", 60], ["period", 30]]);
    const reversal = await reverse(entry);
    expect(String((await reverse(entry))._id)).toBe(String(reversal._id));
    expect(serializeEntitlementBalance(await balance())).toMatchObject({ available: 300, carryoverAvailable: 60, currentPeriodAvailable: 240 });
    await assertLedgerConsistent();
  });

  it("records expired cancellation refunds without reviving them in the next month", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await grant(feb, mar);
    const entry = await redeem(90, "later-cancelled-visit");
    vi.setSystemTime("2026-03-01T12:00:00Z");
    await grant(mar, apr);
    const before = (await balance()).available;
    await reverse(entry);
    await reverse(entry);
    expect((await balance()).available).toBe(before);
    expect(await Ledger.countDocuments({ membership: membership._id, reason: "reversal_original_expired" })).toBe(1);
    expect(await Ledger.findOne({ membership: membership._id, reason: "reversal_original_expired" })).toMatchObject({ amount: -90 });
    await assertLedgerConsistent();
  });

  it("does not turn discretionary manual hours into rollover and debits carry before base", async () => {
    await grant(jan, feb);
    await redeem(240, "all-base-spent");
    await adjust(500, "courtesy-hours");
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await grant(feb, mar);
    expect((await balance()).available).toBe(240);
    vi.setSystemTime("2026-03-01T12:00:00Z");
    await grant(mar, apr);
    await adjust(-90, "correction");
    expect(serializeEntitlementBalance(await balance())).toMatchObject({ available: 210, currentPeriodAvailable: 210, carryoverAvailable: 0 });
    await assertLedgerConsistent();
  });

  it("prevents concurrent overspending and deduplicates simultaneous identical redemptions", async () => {
    await grant(jan, feb);
    const repeated = await Promise.all([redeem(60, "same-visit"), redeem(60, "same-visit")]);
    expect(String(repeated[0]._id)).toBe(String(repeated[1]._id));
    const results = await Promise.allSettled([redeem(120, "visit-a"), redeem(120, "visit-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await balance()).available).toBe(60);
    await assertLedgerConsistent();
  });

  it("keeps refunds expiry-safe for time plans with rollover disabled", async () => {
    await UserMembershipModel.collection.updateOne({ _id: membership._id }, { $set: { "planSnapshot.benefits.0.rolloverPercent": 0 } });
    membership = await UserMembershipModel.findById(membership._id);
    await grant(jan, feb);
    const entry = await redeem(60, "no-carry-visit");
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await grant(feb, mar);
    await reverse(entry);
    expect((await balance()).available).toBe(240);
    await assertLedgerConsistent();
  });

  it("terminal cancellation forfeits carry and late refunds; adjustments cannot revive expired hours", async () => {
    await grant(jan, feb);
    const entry = await redeem(60, "cancelled-membership-visit");
    await transaction(async (session) => {
      await expireMembershipEntitlements({ tenantId: String(membership.tenant), membership,
        reason: "cancelled", idempotencyPrefix: "cancel", session });
      await UserMembershipModel.updateOne({ _id: membership._id }, { $set: { status: "cancelled", isOpen: false } }, { session });
    });
    await reverse(entry);
    expect(await balance()).toMatchObject({ available: 0, rolloverCandidateAvailable: 0 });
    await assertLedgerConsistent();
  });

  it("rejects adjustment after period expiry and unsafe aggregate time imports", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-02-01T12:00:00Z");
    await expect(adjust(60, "too-late")).rejects.toMatchObject({ code: "MEMBERSHIP_ENTITLEMENT_EXPIRED" });
    await expect(transaction((session) => appendMembershipImportAdjustment({ tenantId: String(membership.tenant),
      userId: String(membership.user), membershipId: String(membership._id), benefit: membership.planSnapshot.benefits[0],
      delta: 60, periodStart: jan, periodEnd: feb, actorId: String(membership.user), idempotencyKey: "import-time", session,
    }))).rejects.toMatchObject({ code: "MEMBERSHIP_TIME_IMPORT_UNSUPPORTED" });
  });

  it("only paid invoice periods grant hours; duplicate and late events cannot refill or rewind", async () => {
    await grant(jan, feb);
    await redeem(60, "january-before-stripe-renewal");
    vi.setSystemTime("2026-02-03T12:00:00Z");
    webhookMocks.subscription.mockResolvedValue({ id: "sub_member", status: "active", cancel_at_period_end: false,
      current_period_start: feb.getTime() / 1000, current_period_end: mar.getTime() / 1000 });
    await applyPaymentConfirmed(paymentEvent("evt_paid_feb"), membership, "acct_test", invoiceFor(feb, mar));
    expect((await balance()).available).toBe(300);
    await redeem(30, "february-before-replay");
    await applyPaymentConfirmed(paymentEvent("evt_paid_feb_duplicate", "invoice.payment_succeeded"), membership,
      "acct_test", invoiceFor(feb, mar));
    await applyPaymentConfirmed(paymentEvent("evt_paid_jan_late"), membership, "acct_test", invoiceFor(jan, feb));
    expect((await balance()).available).toBe(270);
    expect(await UserMembershipModel.findById(membership._id)).toMatchObject({ currentPeriodStart: feb, currentPeriodEnd: mar });
    expect(await Ledger.countDocuments({ membership: membership._id, reason: "period_rollover" })).toBe(1);
    await assertLedgerConsistent();
  });

  it("does not use an old checkout's paid flag to fund the latest subscription period", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-02-03T12:00:00Z");
    webhookMocks.subscription.mockResolvedValue({ id: "sub_member", status: "active", cancel_at_period_end: false,
      current_period_start: feb.getTime() / 1000, current_period_end: mar.getTime() / 1000 });
    webhookMocks.invoice.mockResolvedValue(invoiceFor(jan, feb));
    await applyPaymentConfirmed(paymentEvent("evt_checkout_old", "checkout.session.completed"), membership, "acct_test");
    expect(await UserMembershipModel.findById(membership._id)).toMatchObject({ currentPeriodStart: jan, currentPeriodEnd: feb });
    expect(await Ledger.countDocuments({ membership: membership._id, reason: "period_grant" })).toBe(1);
    expect(webhookMocks.invoice).toHaveBeenCalledWith(expect.objectContaining({ invoice: "in_checkout" }));
  });

  it("requires a paid latest invoice during background subscription reconciliation too", async () => {
    await grant(jan, feb);
    vi.setSystemTime("2026-02-03T12:00:00Z");
    webhookMocks.subscription.mockResolvedValue({ id: "sub_member", status: "active", cancel_at_period_end: false,
      latest_invoice: "in_latest", current_period_start: feb.getTime() / 1000, current_period_end: mar.getTime() / 1000 });
    webhookMocks.invoice.mockResolvedValue({ ...invoiceFor(feb, mar), status: "open" });
    await applyPaymentConfirmed(paymentEvent("reconcile:subscription:unpaid", "customer.subscription.updated"), membership, "acct_test");
    expect(await Ledger.countDocuments({ membership: membership._id, reason: "period_grant" })).toBe(1);
    webhookMocks.invoice.mockResolvedValue(invoiceFor(feb, mar));
    await applyPaymentConfirmed(paymentEvent("reconcile:subscription:paid", "customer.subscription.updated"), membership, "acct_test");
    expect((await balance()).available).toBe(300);
    expect(webhookMocks.invoice).toHaveBeenCalledWith(expect.objectContaining({ invoice: "in_latest" }));
  });

  it("rejects unpaid, unrelated or ambiguous recurring invoices instead of guessing their period", () => {
    const invoice = invoiceFor(feb, mar);
    expect(periodFromPaidMembershipInvoice(invoice, "sub_member")).toMatchObject({ start: feb, end: mar });
    expect(() => periodFromPaidMembershipInvoice({ ...invoice, status: "open" }, "sub_member")).toThrow("paid invoice");
    expect(() => periodFromPaidMembershipInvoice(invoice, "sub_other")).toThrow("same subscription");
    expect(() => periodFromPaidMembershipInvoice({ ...invoice, lines: { data: [] } }, "sub_member")).toThrow("unambiguous");
    const ambiguous = { ...invoice, lines: { data: [...invoice.lines.data, ...invoiceFor(jan, feb).lines.data] } };
    expect(() => periodFromPaidMembershipInvoice(ambiguous, "sub_member")).toThrow("unambiguous");
  });
});
