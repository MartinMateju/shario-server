import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import Stripe from "stripe";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Redis is a cache only; auth, route guards, business services, outbox and Mongo
// transactions remain real. External email delivery is never invoked.
vi.mock("@/infrastructure/redis/cache.js", () => ({
  getOrSetCache: (_key, _ttl, load) => load(),
  invalidateCache: vi.fn(),
  invalidateCacheByPrefix: vi.fn(),
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
import Invoice from "@/modules/membership/membership-invoice.schema.js";
import Webhook from "@/modules/membership/membership-webhook-event.schema.js";
import { membershipPlanService } from "@/modules/membership/services/membership-plan.service.js";
import { redeemMembershipEntitlement } from "@/modules/membership/services/membership-entitlement.service.js";
import { resolveMembershipProductDiscount } from "@/modules/membership/services/membership-discount.service.js";
import { reconcileMemberships } from "@/modules/membership/services/membership-reconciliation.service.js";
import { createMembershipPlanSchema } from "@/modules/membership/membership.validators.js";
import {
  RecurringStripeFixture,
  TEST_ACCOUNT,
  TEST_STRIPE_KEY,
  TEST_WEBHOOK_SECRET,
} from "./recurring-stripe-fixture.js";

const ids = Object.fromEntries(
  ["tenant", "member", "other", "grohova", "vaclavska"].map((key) => [
    key,
    new mongoose.Types.ObjectId(),
  ]),
);
const jan = new Date("2027-01-01T00:00:00Z"),
  feb = new Date("2027-02-01T00:00:00Z"),
  mar = new Date("2027-03-01T00:00:00Z"),
  apr = new Date("2027-04-01T00:00:00Z");
const stripe = new RecurringStripeFixture();
const app = express();
app.use("/webhooks/stripe/connect", connectWebhookRouter);
app.use(express.json());
app.use("/memberships", customerMembershipRouter);
app.use(errorHandler);
let db: MongoMemoryReplSet, plan: any;
let eventSequence = 0;
const token = (user = ids.member) =>
  jwt.sign(
    {
      UserInfo: {
        id: String(user),
        tenant: String(ids.tenant),
        email: "member@example.test",
        sessionVersion: 0,
        authContext: "customer",
      },
    },
    process.env.ACCESS_TOKEN_SECRET!,
    { algorithm: "HS256", expiresIn: "1h" },
  );
const mine = async () =>
  (
    await request(app)
      .get("/memberships/mine")
      .auth(token(), { type: "bearer" })
      .expect(200)
  ).body.membership;
const discount = () =>
  resolveMembershipProductDiscount({
    tenantId: String(ids.tenant),
    userId: String(ids.member),
    orderLocationIds: [String(ids.grohova)],
  });
const hook = async (
  type: string,
  object: any,
  eventId = `evt_member_${++eventSequence}`,
  signatureValid = true,
) => {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    account: TEST_ACCOUNT,
    data: { object },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: signatureValid ? TEST_WEBHOOK_SECRET : "wrong-secret",
    timestamp: Math.floor(Date.now() / 1000),
  });
  return request(app)
    .post("/webhooks/stripe/connect")
    .set("Content-Type", "application/json")
    .set("stripe-signature", signature)
    .send(payload);
};
const checkout = async (expectedStatus = 201) => {
  const result = await request(app)
    .post("/memberships/checkout")
    .auth(token(), { type: "bearer" })
    .set("Idempotency-Key", "monthly-membership-checkout")
    .send({
      planId: plan.id,
      currency: "CZK",
      locale: "cs",
      termsAccepted: true,
    })
    .expect(expectedStatus);
  return result.body;
};
const spend = (minutes: number, location: string, key: string) =>
  redeemMembershipEntitlement({
    tenantId: String(ids.tenant),
    userId: String(ids.member),
    benefitKey: "studio_hours",
    quantity: minutes,
    locationId: location,
    reference: { type: "booking", id: key },
    idempotencyKey: key,
    bookingContext: {
      productKind: "open_studio",
      bookingMode: "public",
      participantCount: 1,
      durationMinutes: minutes,
    },
  });
const activate = async () => {
  await checkout();
  const invoice = stripe.period(jan, feb);
  stripe.checkout.status = "complete";
  stripe.checkout.payment_status = "paid";
  expect(
    (await hook("checkout.session.completed", stripe.checkout)).status,
  ).toBe(200);
  return invoice;
};

describe("recurring membership through authenticated HTTP and signed Connect webhooks", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", TEST_STRIPE_KEY);
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all(
      Object.values(mongoose.models).map((model) => model.init()),
    );
    stripe.install();
  }, 60000);
  afterAll(async () => {
    stripe.uninstall();
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await db?.stop();
  });
  beforeEach(async () => {
    for (const collection of Object.values(mongoose.connection.collections))
      await collection.deleteMany({});
    stripe.reset();
    eventSequence = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2027-01-01T12:00:00Z");
    await Tenant.collection.insertOne({
      _id: ids.tenant,
      name: "Membership test studio",
      slug: "membership-http",
      status: "active",
      plan: "studio_plus",
      modules: { memberships: true, payments: true },
      settings: { currency: "CZK", timezone: "Europe/Prague" },
    } as any);
    await TenantSubscription.collection.insertOne({
      tenant: ids.tenant,
      status: "active",
      billingPlan: "studio_plus",
      billingPlanVersion: 3,
    } as any);
    await TenantPaymentAccountModel.create({
      tenant: ids.tenant,
      stripeAccountId: TEST_ACCOUNT,
      accountCreateIdempotencyKey: "fixture",
      onboardingStatus: "complete",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      livemode: false,
    });
    await User.collection.insertMany(
      [ids.member, ids.other].map((_id, index) => ({
        _id,
        tenant: ids.tenant,
        email: `member${index}@example.test`,
        customId: `MEMBER${index}`,
        firstname: "Test",
        lastname: "Member",
        isAccessGranted: true,
        sessionVersion: 0,
        tenantRole: "customer",
        platformRole: "none",
      })),
    );
    await Location.collection.insertMany(
      [ids.grohova, ids.vaclavska].map((_id, index) => ({
        _id,
        tenant: ids.tenant,
        name: index ? "Václavská" : "Grohova",
        slug: String(_id),
        code: String(_id),
        isActive: true,
      })),
    );
    plan = await membershipPlanService.create(
      String(ids.tenant),
      createMembershipPlanSchema.parse({
        name: "Test Profi",
        prices: [{ currency: "CZK", amountMinor: 460000 }],
        billing: { type: "recurring", interval: "month", intervalCount: 1 },
        locationScope: {
          type: "shared_selected",
          locationIds: [String(ids.grohova), String(ids.vaclavska)],
        },
        benefits: [
          {
            key: "studio_hours",
            label: "30 hours",
            type: "allowance",
            unit: "minute",
            quantity: 1800,
            usageScope: "open_studio",
            memberOnly: true,
            rolloverPercent: 25,
          },
          {
            key: "course_discount",
            label: "Course discount",
            type: "percentage",
            appliesTo: "products",
            productScope: "courses",
            memberOnly: true,
            percentageBps: 1000,
          },
        ],
      }),
    );
    await membershipPlanService.publish(String(ids.tenant), plan.id);
  });

  it.each([
    { locale: "en", name: "Pro membership", description: "Shared studio hours" },
    { locale: "cs", name: "Klei Profi", description: "Společný balíček hodin" },
    { locale: "de", name: "Klei Profi", description: "Společný balíček hodin" },
  ])("uses the selected translated product text and primary currency in $locale checkout", async ({ locale, name, description }) => {
    await Tenant.updateOne({ _id: ids.tenant }, { $set: { "settings.publicDefaultLanguage": "cs", "settings.supportedPublicLanguages": ["cs", "en"] } });
    await membershipPlanService.update(String(ids.tenant), {
      id: plan.id, sourceLanguage: "cs", name: "Klei Profi", description: "Společný balíček hodin",
      translations: { en: { name: "Pro membership", description: "Shared studio hours", terms: "Member only" } },
    });
    await membershipPlanService.publish(String(ids.tenant), plan.id);
    const created = await request(app).post("/memberships/checkout").auth(token(), { type: "bearer" })
      .set("Idempotency-Key", `localized-membership-${locale}`)
      .send({ planId: plan.id, currency: "CZK", locale, termsAccepted: true }).expect(201);
    const createRequest = stripe.requests.find((call) => call.method === "POST" && call.path === "/v1/checkout/sessions")!;
    expect(Object.fromEntries(createRequest.body)).toMatchObject({
      "line_items[0][price_data][currency]": "czk",
      "line_items[0][price_data][product_data][name]": name,
      "line_items[0][price_data][product_data][description]": description,
      "line_items[0][price_data][recurring][interval]": "month",
    });
    expect(created.body.membership.planSnapshot.translations.en).toEqual({ name: "Pro membership", description: "Shared studio hours", terms: "Member only" });
    expect((await mine()).planSnapshot.translations.en.name).toBe("Pro membership");
  });

  it("rejects customer currency overrides even when the published plan offers that currency", async () => {
    await membershipPlanService.update(String(ids.tenant), { id: plan.id, prices: [{ currency: "CZK", amountMinor: 460000 }, { currency: "EUR", amountMinor: 18000 }] });
    await membershipPlanService.publish(String(ids.tenant), plan.id);
    const response = await request(app).post("/memberships/checkout").auth(token(), { type: "bearer" })
      .set("Idempotency-Key", "wrong-membership-currency")
      .send({ planId: plan.id, currency: "EUR", locale: "en", termsAccepted: true }).expect(409);
    expect(response.body.code).toBe("MEMBERSHIP_PRIMARY_CURRENCY_REQUIRED");
    expect(await Membership.countDocuments()).toBe(0);
    expect(stripe.requests.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("starts monthly billing only once and gates initial/renewal benefits on actual paid invoices", async () => {
    const created = await checkout();
    expect(created.membership).toMatchObject({
      status: "pending",
      autoRenew: true,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    const createRequest = stripe.requests.find(
      (call) => call.method === "POST" && call.path === "/v1/checkout/sessions",
    )!;
    expect(Object.fromEntries(createRequest.body)).toMatchObject({
      mode: "subscription",
      "line_items[0][price_data][unit_amount]": "460000",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][recurring][interval_count]": "1",
      "subscription_data[metadata][sharioMembershipId]": created.membership.id,
    });
    expect(createRequest.headers["stripe-account"]).toBe(TEST_ACCOUNT);
    await checkout();
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "POST" && call.path === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(await Balance.countDocuments()).toBe(0);
    const first = stripe.period(jan, feb, false);
    stripe.subscription.status = "active"; // Stripe status is not invoice-payment proof.
    expect(
      (await hook("customer.subscription.created", stripe.subscription)).status,
    ).toBe(200);
    expect(await mine()).toMatchObject({
      status: "pending",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(await discount()).toBeNull();
    first.status = "paid";
    first.amount_paid = 460000;
    first.amount_due = 0;
    first.status_transitions.paid_at = Math.floor(Date.now() / 1000);
    stripe.checkout.status = "complete";
    stripe.checkout.payment_status = "paid";
    expect((await hook("invoice.paid", first, "evt_initial_paid")).status).toBe(
      200,
    );
    expect(
      (await hook("checkout.session.completed", stripe.checkout)).status,
    ).toBe(200);
    expect((await hook("invoice.paid", first, "evt_initial_paid")).status).toBe(
      200,
    );
    expect(await mine()).toMatchObject({
      status: "active",
      currentPeriodEnd: feb.toISOString(),
      balances: [{ available: 1800 }],
    });
    expect(await Notification.countDocuments({ type: "activated" })).toBe(1);
    await spend(90, String(ids.grohova), "grohova-visit");
    await spend(150, String(ids.vaclavska), "vaclavska-visit");
    expect(await Balance.countDocuments()).toBe(1);
    expect((await mine()).balances[0].available).toBe(1560);

    vi.setSystemTime("2027-02-01T00:01:00Z");
    const second = stripe.period(feb, mar, false);
    stripe.subscription.status = "active";
    expect(
      (await hook("customer.subscription.updated", stripe.subscription)).status,
    ).toBe(200);
    expect((await mine()).currentPeriodEnd).toBe(feb.toISOString());
    expect(await discount()).toBeNull();
    expect((await mine()).balances[0].available).toBe(0);
    second.status = "paid";
    second.amount_paid = 460000;
    second.amount_due = 0;
    second.status_transitions.paid_at = Math.floor(Date.now() / 1000);
    expect(
      (await hook("invoice.paid", second, "evt_renewal_paid")).status,
    ).toBe(200);
    expect((await hook("invoice.payment_succeeded", second)).status).toBe(200);
    expect(
      (await hook("invoice.paid", second, "evt_renewal_paid")).status,
    ).toBe(200);
    expect(await mine()).toMatchObject({
      currentPeriodStart: feb.toISOString(),
      currentPeriodEnd: mar.toISOString(),
      balances: [
        {
          available: 2250,
          carryoverAvailable: 450,
          currentPeriodAvailable: 1800,
        },
      ],
    });
    expect(await discount()).toMatchObject({ percentageBps: 1000 });
    expect(await Notification.countDocuments({ type: "renewed" })).toBe(1);
    expect(await Invoice.countDocuments()).toBe(2);
    expect(
      (
        await request(app)
          .get("/memberships/mine/invoices")
          .auth(token(), { type: "bearer" })
          .expect(200)
      ).body.total,
    ).toBe(2);
    const debit = await spend(60, String(ids.grohova), "february-carry-first");
    expect(debit.timeAllocations).toMatchObject([
      { kind: "carryover", amount: 60 },
    ]);
    expect((await hook("invoice.paid", first)).status).toBe(200);
    expect((await mine()).balances[0].available).toBe(2190);

    vi.setSystemTime("2027-03-01T00:01:00Z");
    const third = stripe.period(mar, apr);
    expect((await hook("invoice.paid", third)).status).toBe(200);
    expect((await mine()).balances[0]).toMatchObject({
      available: 2250,
      carryoverAvailable: 450,
    });
    expect(await Notification.countDocuments({ type: "renewed" })).toBe(2);
    expect(await Webhook.countDocuments({ status: "failed" })).toBe(0);
    const entries = await Ledger.find().sort({ sequence: 1 }).lean();
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(2250);
    expect(await Notification.countDocuments({ status: "sent" })).toBe(0); // Durable intents, never actual email.
  });

  it("blocks failed renewal benefits, recovers once paid, and cancels/resumes future billing without losing paid time", async () => {
    await activate();
    vi.setSystemTime("2027-02-01T00:01:00Z");
    const renewal = stripe.period(feb, mar, false);
    expect((await hook("invoice.payment_failed", renewal)).status).toBe(200);
    expect(await mine()).toMatchObject({
      status: "past_due",
      currentPeriodEnd: feb.toISOString(),
    });
    expect(await discount()).toBeNull();
    expect(await Notification.countDocuments({ type: "payment_failed" })).toBe(
      1,
    );
    const recovered = stripe.period(feb, mar, true);
    expect((await hook("invoice.paid", recovered)).status).toBe(200);
    expect((await mine()).balances[0].available).toBe(2250);
    expect((await hook("invoice.payment_failed", renewal)).status).toBe(200); // Old event, fresh provider state.
    expect((await mine()).status).toBe("active");
    expect(await Notification.countDocuments({ type: "payment_failed" })).toBe(
      1,
    );
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    expect(stripe.subscription.cancel_at_period_end).toBe(true);
    expect(await mine()).toMatchObject({
      status: "cancel_scheduled",
      autoRenew: false,
      balances: [{ available: 2250 }],
    });
    await request(app)
      .post("/memberships/mine/resume")
      .auth(token(), { type: "bearer" })
      .send({})
      .expect(200);
    expect(stripe.subscription.cancel_at_period_end).toBe(false);
    expect(await mine()).toMatchObject({ status: "active", autoRenew: true });
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    vi.setSystemTime("2027-03-01T00:01:00Z");
    stripe.subscription.status = "canceled";
    expect(
      (await hook("customer.subscription.deleted", stripe.subscription)).status,
    ).toBe(200);
    expect(await Membership.findOne()).toMatchObject({
      status: "cancelled",
      isOpen: false,
      autoRenew: false,
    });
    expect((await Balance.findOne())?.available).toBe(0);
    expect((await hook("invoice.paid", recovered)).status).toBe(200);
    stripe.subscription.status = "active";
    expect(
      (await hook("customer.subscription.updated", stripe.subscription)).status,
    ).toBe(200);
    expect(await Membership.findOne()).toMatchObject({
      status: "cancelled",
      isOpen: false,
    });
    expect((await Balance.findOne())?.available).toBe(0);
  });

  it("expires a pending payment link before cancellation so it cannot create a paid recurring subscription", async () => {
    await checkout();
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    expect(stripe.checkout.status).toBe("expired");
    expect(
      stripe.requests.filter((call) => call.path.endsWith("/expire")),
    ).toHaveLength(1);
    expect(stripe.subscription).toBeNull();
    expect(await Membership.findOne()).toMatchObject({
      status: "cancelled",
      isOpen: false,
      autoRenew: false,
    });
    expect(await Balance.countDocuments()).toBe(0);
  });

  it("activates the first paid term after an initial failed invoice without treating it as a renewal", async () => {
    await checkout();
    const failed = stripe.period(jan, feb, false);
    expect((await hook("invoice.payment_failed", failed)).status).toBe(200);
    expect(await mine()).toMatchObject({
      status: "past_due",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect(await discount()).toBeNull();
    const paid = stripe.period(jan, feb, true);
    expect((await hook("invoice.paid", paid)).status).toBe(200);
    expect(await mine()).toMatchObject({
      status: "active",
      balances: [{ available: 1800 }],
    });
    expect(await Notification.countDocuments({ type: "activated" })).toBe(1);
    expect(await Notification.countDocuments({ type: "renewed" })).toBe(0);
  });

  it("cancels Stripe immediately when the last paid period expired so failed-payment retries cannot continue", async () => {
    await activate();
    vi.setSystemTime("2027-02-01T00:01:00Z");
    const unpaid = stripe.period(feb, mar, false);
    expect((await hook("invoice.payment_failed", unpaid)).status).toBe(200);
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    expect(stripe.subscription.status).toBe("canceled");
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "DELETE" && call.path.includes("/subscriptions/"),
      ),
    ).toHaveLength(1);
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "POST" && call.path.includes("/subscriptions/"),
      ),
    ).toHaveLength(0);
    expect(await Membership.findOne()).toMatchObject({
      status: "cancelled",
      isOpen: false,
      autoRenew: false,
    });
    expect((await Balance.findOne())?.available).toBe(0);
  });

  it("keeps an asynchronous subscription failure recoverable regardless of webhook delivery order", async () => {
    await checkout();
    const unpaid = stripe.period(jan, feb, false);
    stripe.checkout.status = "complete";
    stripe.checkout.payment_status = "unpaid";
    stripe.subscription.latest_invoice = {
      ...unpaid,
      payment_intent: { status: "requires_payment_method" },
    };
    const failedCheckout = structuredClone(stripe.checkout);
    expect(
      (await hook("checkout.session.async_payment_failed", failedCheckout))
        .status,
    ).toBe(200);
    expect(await Membership.findOne()).toMatchObject({
      status: "pending",
      isOpen: true,
    });
    expect((await hook("invoice.payment_failed", unpaid)).status).toBe(200);
    expect(await Membership.findOne()).toMatchObject({
      status: "past_due",
      isOpen: true,
    });
    const paid = stripe.period(jan, feb, true);
    stripe.checkout.payment_status = "paid";
    expect((await hook("invoice.paid", paid)).status).toBe(200);
    expect(
      (await hook("checkout.session.async_payment_failed", failedCheckout))
        .status,
    ).toBe(200);
    expect(await mine()).toMatchObject({
      status: "active",
      balances: [{ available: 1800 }],
    });
    expect(await Notification.countDocuments({ type: "activated" })).toBe(1);
  });

  it("reconciles a later automatic paid invoice when initial asynchronous Checkout failed and its renewal webhook is delayed", async () => {
    await checkout();
    const initial = stripe.period(jan, feb, false);
    initial.status = "void";
    stripe.subscription.status = "active";
    stripe.checkout.status = "complete";
    stripe.subscription.latest_invoice = {
      ...initial,
      payment_intent: { status: "requires_payment_method" },
    };
    expect(
      (await hook("checkout.session.async_payment_failed", stripe.checkout))
        .status,
    ).toBe(200);
    expect(
      await Membership.findOne().select("+stripe.subscriptionId"),
    ).toMatchObject({
      status: "pending",
      stripe: { subscriptionId: stripe.subscription.id },
    });
    vi.setSystemTime("2027-02-01T00:01:00Z");
    stripe.period(feb, mar, true);
    // Original Checkout stays unpaid; paid renewal is discovered from Stripe.
    expect(stripe.checkout.payment_status).toBe("unpaid");
    await reconcileMemberships();
    expect(await mine()).toMatchObject({
      status: "active",
      currentPeriodStart: feb.toISOString(),
      currentPeriodEnd: mar.toISOString(),
      balances: [{ available: 1800, carryoverAvailable: 0 }],
    });
    expect(await Notification.countDocuments({ type: "activated" })).toBe(1);
  });

  it("stops recurring billing after a definitive initial delayed-payment failure even before the invoice webhook arrives", async () => {
    await checkout();
    const failed = stripe.period(jan, feb, false);
    failed.status = "void";
    stripe.subscription.status = "active";
    stripe.subscription.latest_invoice = {
      ...failed,
      payment_intent: { status: "requires_payment_method" },
    };
    stripe.checkout.status = "complete";
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    expect(stripe.subscription.status).toBe("canceled");
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "DELETE" && call.path.includes("/subscriptions/"),
      ),
    ).toHaveLength(1);
    expect(await Membership.findOne()).toMatchObject({
      status: "cancelled",
      isOpen: false,
      autoRenew: false,
    });
    expect(await Balance.countDocuments()).toBe(0);
  });

  it("retries a crash before Session attachment with identical Stripe parameters five seconds later", async () => {
    const original = Membership.findOneAndUpdate.bind(Membership);
    const interrupted = vi
      .spyOn(Membership, "findOneAndUpdate")
      .mockImplementation((...args: any[]) => {
        if (args[1]?.$set?.["stripe.checkoutSessionId"]) {
          return {
            select: () => ({
              exec: async () => {
                throw new Error("Simulated process crash before attach");
              },
            }),
          } as any;
        }
        return (original as any)(...args);
      });
    await checkout(500);
    interrupted.mockRestore();
    const pending = await Membership.findOne().select(
      "+stripe.checkoutExpiresAt +stripe.checkoutSessionId",
    );
    expect(pending?.stripe.checkoutSessionId).toBe("");
    expect(pending?.stripe.checkoutExpiresAt).toBe(stripe.checkout.expires_at);
    vi.setSystemTime(Date.now() + 5000);
    await checkout();
    const creates = stripe.requests.filter(
      (call) => call.method === "POST" && call.path === "/v1/checkout/sessions",
    );
    expect(creates).toHaveLength(2);
    expect(creates[1].body.toString()).toBe(creates[0].body.toString());
    expect(creates[1].headers["idempotency-key"]).toBe(
      creates[0].headers["idempotency-key"],
    );
    expect(await Membership.countDocuments()).toBe(1);
  });

  it("reconciles an unattached paid legacy Session instead of expiring it or creating another subscription", async () => {
    await checkout();
    const invoice = stripe.period(jan, feb);
    stripe.checkout.status = "complete";
    stripe.checkout.payment_status = "paid";
    await Membership.updateOne(
      {},
      {
        $unset: {
          "stripe.checkoutSessionId": "",
          "stripe.checkoutExpiresAt": "",
        },
      },
    );
    vi.setSystemTime("2027-01-01T13:00:00Z");
    await reconcileMemberships();
    expect(await mine()).toMatchObject({
      status: "active",
      balances: [{ available: 1800 }],
    });
    expect(
      await Membership.findOne().select("+stripe.checkoutSessionId"),
    ).toMatchObject({ stripe: { checkoutSessionId: stripe.checkout.id } });
    await reconcileMemberships();
    expect((await hook("invoice.paid", invoice)).status).toBe(200);
    expect(await Balance.countDocuments()).toBe(1);
    expect((await mine()).balances[0].available).toBe(1800);
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "POST" && call.path === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  it("only expires an undiscoverable interrupted request with a known elapsed deadline", async () => {
    await checkout();
    await Membership.updateOne(
      {},
      { $unset: { "stripe.checkoutSessionId": "" } },
    );
    stripe.checkout = null;
    vi.setSystemTime("2027-01-01T13:00:00Z");
    expect((await reconcileMemberships()).pendingClosed).toBe(1);
    expect(await Membership.findOne()).toMatchObject({
      status: "expired",
      isOpen: false,
    });
    await checkout();
    expect(await Membership.countDocuments()).toBe(2);
    expect(await Membership.countDocuments({ isOpen: true })).toBe(1);
  });

  it("keeps legacy unknown outcomes pending and refuses a replacement for a terminal record with a real payment", async () => {
    await checkout();
    const remote = stripe.checkout;
    await Membership.updateOne(
      {},
      {
        $unset: {
          "stripe.checkoutSessionId": "",
          "stripe.checkoutExpiresAt": "",
        },
      },
    );
    stripe.checkout = null;
    vi.setSystemTime("2027-01-01T13:00:00Z");
    expect((await reconcileMemberships()).pendingClosed).toBe(0);
    expect(await Membership.findOne()).toMatchObject({
      status: "pending",
      isOpen: true,
    });
    await checkout(409);
    stripe.checkout = remote;
    stripe.period(jan, feb);
    stripe.checkout.status = "complete";
    stripe.checkout.payment_status = "paid";
    await Membership.updateOne(
      {},
      { $set: { status: "expired", isOpen: false } },
    );
    await checkout(409);
    expect(
      stripe.requests.filter(
        (call) =>
          call.method === "POST" && call.path === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(await Membership.countDocuments()).toBe(1);
  });

  it("recovers a payment that wins the cancellation race and stops only the next recurring charge", async () => {
    await checkout();
    stripe.period(jan, feb);
    stripe.completeDuringExpiration = true;
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(200);
    expect(stripe.checkout.payment_status).toBe("paid");
    expect(stripe.subscription.cancel_at_period_end).toBe(true);
    expect(await mine()).toMatchObject({
      status: "cancel_scheduled",
      currentPeriodEnd: feb.toISOString(),
      autoRenew: false,
      balances: [{ available: 1800 }],
    });
    expect(await Notification.countDocuments({ type: "activated" })).toBe(1);
    expect(
      await Notification.countDocuments({ type: "cancellation_scheduled" }),
    ).toBe(1);
  });

  it("keeps an in-flight asynchronous payment pending instead of abandoning a possible charge", async () => {
    await checkout();
    stripe.checkout.status = "complete";
    stripe.checkout.payment_status = "unpaid";
    await request(app)
      .post("/memberships/mine/cancel")
      .auth(token(), { type: "bearer" })
      .send({ reason: "not_using" })
      .expect(409);
    expect(await Membership.findOne()).toMatchObject({
      status: "pending",
      isOpen: true,
    });
    expect(await Balance.countDocuments()).toBe(0);
    expect(
      stripe.requests.filter((call) => call.path.endsWith("/expire")),
    ).toHaveLength(0);
  });

  it("rejects unauthenticated checkout, forged signatures and another customer's checkout recovery", async () => {
    await request(app).post("/memberships/checkout").send({}).expect(401);
    await checkout();
    await request(app)
      .get(`/memberships/checkout/${stripe.checkout.id}`)
      .auth(token(ids.other), { type: "bearer" })
      .expect(404);
    const invoice = stripe.period(jan, feb);
    expect(
      (await hook("invoice.paid", invoice, "evt_bad_signature", false)).status,
    ).toBe(400);
    expect(await Balance.countDocuments()).toBe(0);
    expect(await Webhook.countDocuments()).toBe(0);
  });
});
