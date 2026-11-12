import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/redis/cache.js", () => ({
  getOrSetCache: (_key, _ttl, load) => load(),
  invalidateCache: vi.fn(), invalidateCacheByPrefix: vi.fn(),
}));
import { customerMembershipRouter } from "@/modules/membership/routes/membership.routes.js";
import connectWebhookRouter from "@/modules/tenant-payments/routes/tenant-payment-connect.webhook.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import TenantSubscription from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import { TenantPaymentAccountModel } from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import User from "@/modules/user/user.model.js";
import Location from "@/modules/location/location.model.js";
import Membership from "@/modules/membership/user-membership.model.js";
import Balance from "@/modules/membership/membership-entitlement-balance.schema.js";
import Ledger from "@/modules/membership/membership-entitlement-ledger.schema.js";
import Notification from "@/modules/membership/membership-notification.schema.js";
import { membershipPlanService } from "@/modules/membership/services/membership-plan.service.js";
import { redeemMembershipEntitlement } from "@/modules/membership/services/membership-entitlement.service.js";
import { createMembershipPlanSchema } from "@/modules/membership/membership.validators.js";
import { RecurringStripeFixture, TEST_ACCOUNT, TEST_STRIPE_KEY, TEST_WEBHOOK_SECRET } from "./recurring-stripe-fixture.js";

const ids = Object.fromEntries(["tenant", "member", "other", "location"].map((key) => [key, new mongoose.Types.ObjectId()]));
const jan = new Date("2027-01-01T00:00:00Z"), feb = new Date("2027-02-01T00:00:00Z"),
  mar = new Date("2027-03-01T00:00:00Z"), apr = new Date("2027-04-01T00:00:00Z"),
  may = new Date("2027-05-01T00:00:00Z");
const stripe = new RecurringStripeFixture();
const app = express();
app.use("/webhooks/stripe/connect", connectWebhookRouter);
app.use(express.json());
app.use("/memberships", customerMembershipRouter);
app.use(errorHandler);
let db: MongoMemoryReplSet, original: any, target: any, eventSequence = 0;
const token = (user = ids.member) => jwt.sign({ UserInfo: {
  id: String(user), tenant: String(ids.tenant), email: "member@example.test", sessionVersion: 0, authContext: "customer",
} }, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "1h" });
const mine = async () => (await request(app).get("/memberships/mine").auth(token(), { type: "bearer" }).expect(200)).body.membership;
const hook = async (type: string, object: any, eventId = `evt_plan_change_${++eventSequence}`) => {
  const payload = JSON.stringify({ id: eventId, object: "event", type,
    created: Math.floor(Date.now() / 1000), livemode: false, account: TEST_ACCOUNT, data: { object } });
  return request(app).post("/webhooks/stripe/connect").set("Content-Type", "application/json")
    .set("stripe-signature", Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) })).send(payload);
};
const change = (plan = target, key = "schedule-membership-change-1", overrides: Record<string, unknown> = {}) =>
  request(app).post("/memberships/mine/plan-change").auth(token(), { type: "bearer" })
    .set("Idempotency-Key", key).send({ planId: plan.id, planVersionId: plan.publishedVersion.id,
      termsAccepted: true, locale: "en", ...overrides });
const cancelChange = () => request(app).delete("/memberships/mine/plan-change").auth(token(), { type: "bearer" });
const createPlan = async (name: string, amountMinor: number, benefitKey: string, quantity: number, overrides: Record<string, unknown> = {}) => {
  const plan = await membershipPlanService.create(String(ids.tenant), createMembershipPlanSchema.parse({
    name, prices: [{ currency: "CZK", amountMinor }],
    billing: { type: "recurring", interval: "month", intervalCount: 1 },
    locationScope: { type: "all", locationIds: [] },
    benefits: [{ key: benefitKey, label: name, type: "allowance", unit: "minute", quantity,
      usageScope: "open_studio", memberOnly: true, rolloverPercent: 25 }], ...overrides,
  }));
  return membershipPlanService.publish(String(ids.tenant), plan.id);
};
const activate = async () => {
  await request(app).post("/memberships/checkout").auth(token(), { type: "bearer" })
    .set("Idempotency-Key", "plan-change-original-checkout").send({ planId: original.id,
      currency: "CZK", locale: "en", termsAccepted: true }).expect(201);
  const invoice = stripe.period(jan, feb);
  stripe.checkout.status = "complete";
  stripe.checkout.payment_status = "paid";
  expect((await hook("checkout.session.completed", stripe.checkout)).status).toBe(200);
  return invoice;
};
const spend = (quantity: number, key: string) => redeemMembershipEntitlement({
  tenantId: String(ids.tenant), userId: String(ids.member), benefitKey: "studio_hours", quantity,
  locationId: String(ids.location), reference: { type: "booking", id: key }, idempotencyKey: key,
  bookingContext: { productKind: "open_studio", bookingMode: "public", participantCount: 1, durationMinutes: quantity },
});
const mutations = () => stripe.requests.filter((call) => call.method !== "GET");

describe("membership plan changes at the next monthly renewal", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", TEST_STRIPE_KEY);
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    stripe.install();
  }, 60000);
  afterAll(async () => {
    stripe.uninstall(); vi.unstubAllEnvs(); vi.useRealTimers();
    await mongoose.disconnect(); await db?.stop();
  });
  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
    stripe.reset(); eventSequence = 0;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2027-01-01T12:00:00Z");
    await Tenant.collection.insertOne({ _id: ids.tenant, name: "Plan change studio", slug: "member-change",
      status: "active", plan: "studio_plus", modules: { memberships: true, payments: true },
      settings: { currency: "CZK", timezone: "Europe/Prague" } } as any);
    await TenantSubscription.collection.insertOne({ tenant: ids.tenant, status: "active", billingPlan: "studio_plus", billingPlanVersion: 3 } as any);
    await TenantPaymentAccountModel.create({ tenant: ids.tenant, stripeAccountId: TEST_ACCOUNT,
      accountCreateIdempotencyKey: "fixture", onboardingStatus: "complete", chargesEnabled: true,
      payoutsEnabled: true, detailsSubmitted: true, livemode: false });
    await User.collection.insertMany([ids.member, ids.other].map((_id, index) => ({ _id, tenant: ids.tenant,
      email: `planmember${index}@example.test`, customId: `PLANMEMBER${index}`, firstname: "Test", lastname: "Member",
      isAccessGranted: true, sessionVersion: 0, tenantRole: "customer", platformRole: "none" })));
    await Location.collection.insertOne({ _id: ids.location, tenant: ids.tenant, name: "Studio",
      slug: String(ids.location), code: String(ids.location), isActive: true });
    original = await createPlan("Original 30 hours", 460000, "studio_hours", 1800, { benefits: [
      { key: "studio_hours", label: "30 hours", type: "allowance", unit: "minute", quantity: 1800,
        usageScope: "open_studio", memberOnly: true, rolloverPercent: 25 },
      { key: "old_credits", label: "Old credits", type: "allowance", unit: "credit", quantity: 75 },
    ] });
    target = await createPlan("Target 60 hours", 620000, "new_studio_hours", 3600);
  });

  it("keeps the paid plan unchanged, then grants the paid replacement and old regular-hour carry exactly once", async () => {
    await activate();
    vi.setSystemTime("2027-02-01T12:00:00Z");
    expect((await hook("invoice.paid", stripe.period(feb, mar))).status).toBe(200);
    expect((await mine()).balances.find((balance) => balance.benefitKey === "studio_hours")).toMatchObject({ available: 2250, carryoverAvailable: 450 });
    await spend(1200, "consume-old-carry-and-regular"); // consumes 450 carry, then 750 regular
    const before = await mine();
    expect(before.canSchedulePlanChange).toBe(true);
    const response = await change().expect(200);
    expect(response.body.membership).toMatchObject({ id: before.id, planId: original.id, amountMinor: 460000,
      currentPeriodStart: feb.toISOString(), currentPeriodEnd: mar.toISOString(),
      scheduledPlanChange: { planId: target.id, planVersionId: target.publishedVersion.id,
        effectiveAt: mar.toISOString(), status: "scheduled", amountMinor: 620000, currency: "CZK" } });
    expect(response.body.membership.planSnapshot).toEqual(before.planSnapshot);
    expect(response.body.membership.canSchedulePlanChange).toBe(false);
    expect((await mine()).balances).toEqual(before.balances);
    expect(stripe.subscription.items.data[0].price.unit_amount).toBe(460000);
    expect(stripe.invoices.size).toBe(2);
    expect(stripe.requests.filter((call) => call.path === "/v1/checkout/sessions" && call.method === "POST")).toHaveLength(1);
    const scheduleUpdate = stripe.requests.find((call) => call.method === "POST" && /\/v1\/subscription_schedules\/[^/]+$/.test(call.path))!;
    expect(Object.fromEntries(scheduleUpdate.body)).toMatchObject({
      proration_behavior: "none", end_behavior: "release", "phases[0][proration_behavior]": "none",
      "phases[0][end_date]": String(mar.getTime() / 1000), "phases[1][proration_behavior]": "none",
      "phases[1][start_date]": String(mar.getTime() / 1000),
    });
    expect(mutations().every((call) => call.headers["stripe-account"] === TEST_ACCOUNT)).toBe(true);

    // Publishing another target version must not change the frozen agreement.
    await membershipPlanService.update(String(ids.tenant), { id: target.id, name: "Later draft", prices: [{ currency: "CZK", amountMinor: 990000 }] });
    await membershipPlanService.publish(String(ids.tenant), target.id);
    vi.setSystemTime("2027-03-01T00:01:00Z");
    const failed = stripe.period(mar, apr, false);
    expect(failed.total).toBe(620000);
    expect((await hook("customer.subscription.updated", stripe.subscription)).status).toBe(200);
    expect((await hook("invoice.payment_failed", failed)).status).toBe(200);
    expect(await mine()).toMatchObject({ status: "past_due", planId: original.id, amountMinor: 460000, currentPeriodEnd: mar.toISOString() });
    expect(await Balance.findOne({ benefitKey: "new_studio_hours" })).toBeNull();

    const paid = stripe.period(mar, apr, true);
    expect((await hook("invoice.paid", paid, "evt_plan_switch_paid")).status).toBe(200);
    const after = await mine();
    expect(after).toMatchObject({ id: before.id, planId: target.id, planVersionId: target.publishedVersion.id,
      amountMinor: 620000, currentPeriodStart: mar.toISOString(), currentPeriodEnd: apr.toISOString() });
    expect(after.planSnapshot.name).toBe("Target 60 hours");
    expect(after.scheduledPlanChange).toBeNull();
    expect(after.balances.find((balance) => balance.benefitKey === "new_studio_hours")).toMatchObject({
      available: 4050, currentPeriodAvailable: 3600, carryoverAvailable: 450,
    });
    expect((await Balance.findOne({ benefitKey: "studio_hours" }))?.available).toBe(0);
    expect((await Balance.findOne({ benefitKey: "old_credits" }))?.available).toBe(0);
    expect(await Membership.countDocuments()).toBe(1);
    const ledgerCount = await Ledger.countDocuments();
    expect((await hook("invoice.paid", paid, "evt_plan_switch_paid")).status).toBe(200);
    expect((await hook("invoice.payment_succeeded", paid)).status).toBe(200);
    expect(await Ledger.countDocuments()).toBe(ledgerCount);
    expect(await Notification.countDocuments({ status: "sent" })).toBe(0);
  });

  it("replays one request, rejects a second target, and releases a cancelled change without cancelling the membership", async () => {
    await activate();
    const initial = await change().expect(200);
    await change().expect(200);
    expect(stripe.schedules.size).toBe(1);
    expect(stripe.prices.size).toBe(2);
    const another = await createPlan("Other plan", 510000, "other_hours", 2400);
    await change(another, "a-different-plan-change").expect(409);
    await cancelChange().expect(200);
    await cancelChange().expect(200);
    expect((await mine()).scheduledPlanChange).toBeNull();
    expect((await mine()).id).toBe(initial.body.membership.id);
    expect(stripe.subscription).toMatchObject({ status: "active", cancel_at_period_end: false, schedule: null });
    expect([...stripe.schedules.values()][0].status).toBe("released");
    expect(stripe.requests.some((call) => /subscription_schedules\/.*\/cancel/.test(call.path))).toBe(false);
    vi.setSystemTime("2027-02-01T00:01:00Z");
    expect((await hook("invoice.paid", stripe.period(feb, mar))).status).toBe(200);
    expect(await mine()).toMatchObject({ planId: original.id, amountMinor: 460000 });
  });

  it("rejects missing consent, stale target versions and a foreign customer before Stripe mutations", async () => {
    await activate();
    const before = mutations().length;
    await change(target, "change-without-consent", { termsAccepted: false }).expect(400);
    await change(target, "change-with-stale-version", { planVersionId: String(new mongoose.Types.ObjectId()) }).expect(409);
    await request(app).post("/memberships/mine/plan-change").auth(token(ids.other), { type: "bearer" })
      .set("Idempotency-Key", "foreign-customer-change").send({ planId: target.id,
        planVersionId: target.publishedVersion.id, termsAccepted: true }).expect((response) => expect([404, 409]).toContain(response.status));
    expect(mutations()).toHaveLength(before);
  });

  it("serializes simultaneous different plan-change requests into one subscription schedule", async () => {
    await activate();
    const other = await createPlan("Concurrent choice", 520000, "concurrent_hours", 2400);
    const results = await Promise.all([change(), change(other, "concurrent-different-change")]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(stripe.schedules.size).toBe(1);
    expect(stripe.prices.size).toBe(2);
    expect(await Membership.countDocuments()).toBe(1);
  });

  it("requires cancelling a pending plan change before cancelling the subscription", async () => {
    await activate(); await change().expect(200);
    const before = mutations().length;
    await request(app).post("/memberships/mine/cancel").auth(token(), { type: "bearer" })
      .send({ reason: "not_using" }).expect(409);
    expect(mutations()).toHaveLength(before);
    expect(stripe.subscription.cancel_at_period_end).toBe(false);
    await cancelChange().expect(200);
    await request(app).post("/memberships/mine/cancel").auth(token(), { type: "bearer" })
      .send({ reason: "not_using" }).expect(200);
    expect(stripe.subscription.cancel_at_period_end).toBe(true);
    expect((await mine()).status).toBe("cancel_scheduled");
  });

  it("serializes a simultaneous subscription cancellation against a new plan schedule", async () => {
    await activate();
    const results = await Promise.all([
      change(),
      request(app).post("/memberships/mine/cancel").auth(token(), { type: "bearer" }).send({ reason: "not_using" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const current = await mine();
    if (current.scheduledPlanChange) {
      expect(current.status).toBe("active");
      expect(stripe.subscription.cancel_at_period_end).toBe(false);
      expect(stripe.schedules.size).toBe(1);
    } else {
      expect(current.status).toBe("cancel_scheduled");
      expect(stripe.subscription.cancel_at_period_end).toBe(true);
      expect(stripe.schedules.size).toBe(0);
    }
    expect(await Membership.countDocuments()).toBe(1);
  });

  it("recovers an uncertain Stripe update with the same request and never creates another subscription", async () => {
    await activate();
    stripe.scheduleUpdateResponsesToDrop = 3; // First SDK call plus its two network retries.
    await change().expect(500);
    const interrupted = await mine();
    expect(interrupted.planId).toBe(original.id);
    expect(interrupted.scheduledPlanChange.status).toBe("preparing");
    await change().expect(200);
    expect((await mine()).scheduledPlanChange.status).toBe("scheduled");
    expect(stripe.schedules.size).toBe(1);
    expect(stripe.prices.size).toBe(2);
    expect(stripe.requests.filter((call) => call.method === "POST" && call.path === "/v1/checkout/sessions")).toHaveLength(1);
  });

  it.each(["price", "schedule"])("unwinds a %s outage before configuration and honors the old paid renewal", async (step) => {
    await activate();
    if (step === "price") stripe.priceRequestsToReject = 3;
    else stripe.scheduleUpdateRequestsToReject = 3;
    await change().expect(500);
    expect((await mine()).scheduledPlanChange.status).toBe("preparing");
    vi.setSystemTime("2027-02-01T00:01:00Z");
    const paid = stripe.period(feb, mar);
    expect(paid.total).toBe(460000);
    expect((await hook("invoice.paid", paid)).status).toBe(200);
    const renewed = await mine();
    expect(renewed).toMatchObject({ planId: original.id, amountMinor: 460000,
      currentPeriodStart: feb.toISOString(), currentPeriodEnd: mar.toISOString(), scheduledPlanChange: null,
      canSchedulePlanChange: true });
    expect(renewed.balances.find((balance) => balance.benefitKey === "studio_hours")).toMatchObject({
      currentPeriodAvailable: 1800, carryoverAvailable: 450, available: 2250,
    });
    expect(await Balance.findOne({ benefitKey: "new_studio_hours" })).toBeNull();
    expect(stripe.subscription.schedule).toBeNull();
    await change(target, "plan-change-after-outage-renewal").expect(200);
    expect((await mine()).scheduledPlanChange.effectiveAt).toBe(mar.toISOString());
  });

  it("applies a configured target from its paid renewal even when the scheduling response was lost", async () => {
    await activate();
    stripe.scheduleUpdateResponsesToDrop = 3;
    await change().expect(500);
    expect((await mine()).scheduledPlanChange.status).toBe("preparing");
    vi.setSystemTime("2027-02-01T00:01:00Z");
    const paid = stripe.period(feb, mar);
    expect(paid.total).toBe(620000);
    expect((await hook("invoice.paid", paid)).status).toBe(200);
    expect(await mine()).toMatchObject({ planId: target.id, scheduledPlanChange: null, amountMinor: 620000 });
  });

  it.each(["past_due", "cancel_scheduled", "paused"])("rejects an existing %s membership", async (status) => {
    await activate();
    await Membership.collection.updateOne({ user: ids.member }, { $set: { status,
      ...(status === "cancel_scheduled" ? { cancelAtPeriodEnd: true, autoRenew: false } : {}) } });
    const before = mutations().length;
    await change().expect(409);
    expect(mutations()).toHaveLength(before);
  });

  it("rejects yearly and different-currency target plans", async () => {
    await activate();
    const yearly = await createPlan("Yearly", 6200000, "yearly_hours", 3600, {
      billing: { type: "recurring", interval: "year", intervalCount: 1 }, benefits: [],
    });
    // A studio currency change does not change an existing customer's contract.
    await Tenant.updateOne({ _id: ids.tenant }, { $set: { "settings.currency": "EUR" } });
    const euro = await createPlan("Euro", 25000, "euro_hours", 3600, { prices: [{ currency: "EUR", amountMinor: 25000 }] });
    const before = mutations().length;
    await change(yearly, "yearly-plan-change").expect(409);
    await change(euro, "euro-plan-change").expect(409);
    expect(mutations()).toHaveLength(before);
  });

  it("does not apply a target plan from a paid invoice with the wrong Stripe price", async () => {
    await activate(); await change().expect(200);
    vi.setSystemTime("2027-02-01T00:01:00Z");
    const renewal = stripe.period(feb, mar);
    renewal.lines.data[0].price = stripe.prices.get("price_membership_original");
    await hook("invoice.paid", renewal, "evt_wrong_target_price");
    expect(await mine()).toMatchObject({ planId: original.id, amountMinor: 460000, currentPeriodEnd: feb.toISOString() });
    expect(await Balance.findOne({ benefitKey: "new_studio_hours" })).toBeNull();
  });

  it("can recover on a later matching paid period without carrying hours across an unpaid gap", async () => {
    await activate(); await change().expect(200);
    vi.setSystemTime("2027-02-01T00:01:00Z");
    expect((await hook("invoice.payment_failed", stripe.period(feb, mar, false))).status).toBe(200);
    vi.setSystemTime("2027-03-01T00:01:00Z");
    const recovered = stripe.period(mar, apr, true);
    expect((await hook("invoice.paid", recovered)).status).toBe(200);
    expect(await mine()).toMatchObject({ planId: target.id, currentPeriodStart: mar.toISOString(), currentPeriodEnd: apr.toISOString() });
    expect((await mine()).balances.find((balance) => balance.benefitKey === "new_studio_hours")).toMatchObject({ available: 3600, carryoverAvailable: 0 });
    vi.setSystemTime("2027-04-01T00:01:00Z");
    expect((await hook("invoice.paid", stripe.period(apr, may))).status).toBe(200);
    expect((await mine()).balances.find((balance) => balance.benefitKey === "new_studio_hours")).toMatchObject({ available: 4500, carryoverAvailable: 900 });
  });
});
