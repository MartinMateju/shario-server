import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type Stripe from "stripe";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock(
  "@/modules/workspace-notifications/workspace-notification.events.js",
  () => ({
    emitWorkspaceNotificationEvent: vi.fn(),
  }),
);

import Tenant from "@/modules/tenants/tenant.model.js";
import Subscription from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import { getCommercialPriceSpec } from "@/modules/tenant-subscription/tenant-subscription.commercial.js";
import {
  buildStripePriceCreateParams,
  buildStripeProductMetadata,
} from "@/modules/tenant-subscription/tenant-subscription.stripe-contract.js";
import { syncStripeSubscriptionSnapshotWithResult as sync } from "@/modules/tenant-subscription/services/tenant-subscription.sync.service.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";

const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const customerId = "cus_local_fixture";
const baseTime = 1_790_000_000;

function snapshot({
  id = "sub_current",
  plan = "professional",
  status = "active",
  created = baseTime,
  tenant = String(tenantId),
  customer = customerId,
}: {
  id?: string;
  plan?: "starter" | "professional";
  status?: Stripe.Subscription.Status;
  created?: number;
  tenant?: string;
  customer?: string;
} = {}): Stripe.Subscription {
  const spec = getCommercialPriceSpec(plan, "monthly", 3)!;
  return {
    id,
    object: "subscription",
    created,
    status,
    customer,
    currency: "czk",
    current_period_start: created,
    current_period_end: created + 30 * 86400,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    metadata: {
      tenantId: tenant,
      plan,
      planVersion: "3",
      offerId: spec.offerId,
      billingInterval: "monthly",
      priceLookupKey: spec.lookupKey,
    },
    items: {
      data: [
        {
          id: "si_fixture",
          quantity: 1,
          price: {
            ...buildStripePriceCreateParams(spec, "prod_fixture"),
            id: "price_fixture",
            active: true,
            livemode: false,
            type: "recurring",
            billing_scheme: "per_unit",
            product: {
              id: "prod_fixture",
              active: true,
              livemode: false,
              name: `shario.io ${spec.displayName}`,
              metadata: buildStripeProductMetadata(spec),
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

const checkout = (subscriptionId: string) => ({
  id: `cs_${subscriptionId}`,
  tenantId: String(tenantId),
  customerId,
  subscriptionId,
});
const failed = {
  state: "failed",
  attemptCount: 1,
  failureReason: "payment_failed",
} as const;

async function seed(overrides: Record<string, unknown> = {}) {
  await Tenant.create({
    _id: tenantId,
    name: "Fixture",
    slug: "sync-fixture",
    status: "active",
    plan: "professional",
    planVersion: 3,
    limits: { locations: 2 },
  });
  return Subscription.create({
    tenant: tenantId,
    status: "active",
    billingPlan: "professional",
    planVersion: 3,
    currentPeriodStart: new Date(baseTime * 1000),
    stripe: {
      customerId,
      subscriptionId: "sub_current",
      subscriptionCreatedAt: baseTime,
    },
    ...overrides,
  });
}

describe("tenant Stripe projections with real Mongo transactions", () => {
  let replica: MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    vi.stubEnv("STRIPE_TENANT_BILLING_MODE", "test");
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all(
      [Tenant, Subscription].map((model) => model.createCollection()),
    );
    await Subscription.createIndexes();
  }, 60_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all([Tenant.deleteMany({}), Subscription.deleteMany({})]);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await replica?.stop();
  });

  it("ignores subscription and invoice events before completed Checkout, preserving a manual grant and its limits", async () => {
    const local = await seed({ stripe: { customerId } });
    const original = (await Subscription.findById(local._id).lean())!;
    await sync({
      stripeSubscription: snapshot({ plan: "starter" }),
      eventCreatedAt: baseTime + 1,
    });
    const invoice = await sync({
      stripeSubscription: snapshot({ status: "past_due", plan: "starter" }),
      eventCreatedAt: baseTime + 2,
      latestInvoiceId: "in_before_checkout",
      paymentRecovery: failed,
    });
    expect(invoice.paymentEventApplied).toBe(false);
    expect(await Subscription.findById(local._id).lean()).toEqual(original);
    expect((await Tenant.findById(tenantId))?.limits.locations).toBe(2);
    expect(emitWorkspaceNotificationEvent).not.toHaveBeenCalled();

    const bound = await sync({
      stripeSubscription: snapshot({ plan: "starter" }),
      eventCreatedAt: baseTime + 3,
      completedCheckout: checkout("sub_current"),
    });
    expect(bound.subscription.stripe.subscriptionId).toBe("sub_current");
    expect(bound.subscription.billingPlan).toBe("starter");
    expect((await Tenant.findById(tenantId))?.plan).toBe("starter");
    const payment = await sync({
      stripeSubscription: snapshot({ status: "past_due", plan: "starter" }),
      eventCreatedAt: baseTime + 4,
      latestInvoiceId: "in_after_checkout",
      paymentRecovery: failed,
    });
    expect(payment.paymentEventApplied).toBe(true);
    expect(payment.subscription.latestInvoiceId).toBe("in_after_checkout");
    expect(payment.subscription.lastPaymentFailedAt).toEqual(
      new Date((baseTime + 4) * 1000),
    );
  });

  it("binds a completed local trial Checkout without losing the trial entitlement", async () => {
    await seed({
      status: "trialing",
      stripe: { customerId },
      trialPlan: "professional",
      trialPlanVersion: 3,
    });
    const result = await sync({
      stripeSubscription: snapshot({ status: "trialing", plan: "starter" }),
      completedCheckout: checkout("sub_current"),
      eventCreatedAt: baseTime + 1,
    });
    expect(result.subscription.status).toBe("trialing");
    expect(result.subscription.billingPlan).toBe("starter");
    expect((await Tenant.findById(tenantId))?.plan).toBe("professional");
  });

  it("rejects tenant/customer identity mismatches without changing either projection", async () => {
    await seed();
    await expect(
      sync({ stripeSubscription: snapshot({ tenant: String(otherTenantId) }) }),
    ).rejects.toThrow(/identity does not match/);
    await expect(
      sync({ stripeSubscription: snapshot({ customer: "cus_foreign" }) }),
    ).rejects.toThrow(/identity does not match/);
    await expect(
      sync({
        stripeSubscription: snapshot(),
        completedCheckout: {
          ...checkout("sub_current"),
          tenantId: String(otherTenantId),
        },
      }),
    ).rejects.toThrow(/identity does not match/);
    expect(
      (await Subscription.findOne({ tenant: tenantId }))?.stripe.subscriptionId,
    ).toBe("sub_current");
    expect((await Tenant.findById(tenantId))?.limits.locations).toBe(2);
  });

  it("requires completed Checkout for a newer replacement and ignores retired events, even after the replacement ends", async () => {
    await seed({
      status: "canceled",
      lastPaymentFailedAt: new Date(),
      latestInvoiceId: "in_old",
      lastStripeEventCreatedAt: baseTime + 500,
    });
    const next = snapshot({
      id: "sub_next",
      plan: "starter",
      created: baseTime + 1000,
    });
    await sync({ stripeSubscription: next, eventCreatedAt: baseTime + 1001 });
    expect(
      (await Subscription.findOne({ tenant: tenantId }))?.stripe.subscriptionId,
    ).toBe("sub_current");
    const replaced = await sync({
      stripeSubscription: next,
      eventCreatedAt: baseTime + 1002,
      completedCheckout: checkout("sub_next"),
    });
    expect(replaced.subscription.stripe.subscriptionId).toBe("sub_next");
    expect(replaced.subscription.lastPaymentFailedAt).toBeUndefined();
    expect(replaced.subscription.latestInvoiceId).toBeUndefined();
    await sync({
      stripeSubscription: { ...next, status: "canceled" },
      eventCreatedAt: baseTime + 1003,
    });
    vi.mocked(emitWorkspaceNotificationEvent).mockClear();
    const ignored = await sync({
      stripeSubscription: snapshot({ status: "past_due" }),
      paymentRecovery: failed,
      eventCreatedAt: baseTime + 2000,
    });
    expect(ignored.paymentEventApplied).toBe(false);
    await sync({
      stripeSubscription: snapshot(),
      completedCheckout: checkout("sub_current"),
      eventCreatedAt: baseTime + 2001,
    });
    const final = (await Subscription.findOne({ tenant: tenantId }))!;
    expect(final.stripe.subscriptionId).toBe("sub_next");
    expect(final.status).toBe("canceled");
    expect(final.lastStripeEventCreatedAt).toBe(baseTime + 1003);
    expect((await Tenant.findById(tenantId))?.plan).toBe("starter");
    expect(emitWorkspaceNotificationEvent).not.toHaveBeenCalled();
  });

  it("supports legacy replacement using the prior period boundary, but fails closed when all chronology is absent", async () => {
    const local = await seed({
      status: "canceled",
      stripe: { customerId, subscriptionId: "sub_current" },
    });
    const next = snapshot({ id: "sub_next", created: baseTime + 1000 });
    await Subscription.updateOne(
      { _id: local._id },
      { $unset: { currentPeriodStart: 1 } },
    );
    await sync({
      stripeSubscription: next,
      completedCheckout: checkout("sub_next"),
    });
    expect(
      (await Subscription.findById(local._id))?.stripe.subscriptionId,
    ).toBe("sub_current");
    await Subscription.updateOne(
      { _id: local._id },
      { $set: { currentPeriodStart: new Date(baseTime * 1000) } },
    );
    await sync({
      stripeSubscription: next,
      completedCheckout: checkout("sub_next"),
    });
    expect(
      (await Subscription.findById(local._id))?.stripe.subscriptionId,
    ).toBe("sub_next");
  });

  it.each([false, true])(
    "concurrent snapshots keep the newest cursor and matching tenant plan (new first: %s)",
    async (newFirst) => {
      await seed();
      const original = Subscription.collection.findOneAndUpdate.bind(
        Subscription.collection,
      );
      let arrivals = 0;
      let release!: () => void;
      const bothReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(Subscription.collection, "findOneAndUpdate").mockImplementation(
        async (...args: Parameters<typeof original>) => {
          if (++arrivals <= 2) {
            if (arrivals === 2) release();
            await bothReady;
          }
          return original(...args);
        },
      );
      const inputs = [
        {
          stripeSubscription: snapshot({
            status: "past_due",
            plan: "professional",
          }),
          eventCreatedAt: baseTime + 1,
        },
        {
          stripeSubscription: snapshot({ status: "active", plan: "starter" }),
          eventCreatedAt: baseTime + 2,
        },
      ];
      await Promise.all(
        (newFirst ? inputs.reverse() : inputs).map((input) => sync(input)),
      );
      const local = (await Subscription.findOne({ tenant: tenantId }))!;
      expect(local.lastStripeEventCreatedAt).toBe(baseTime + 2);
      expect(local.status).toBe("active");
      expect(local.billingPlan).toBe("starter");
      expect(local.graceEndsAt).toBeUndefined();
      expect((await Tenant.findById(tenantId))?.plan).toBe("starter");
    },
  );

  it("rolls back the subscription and emits no notification when the matching tenant projection fails", async () => {
    const local = await seed();
    const original = await Subscription.findById(local._id).lean();
    vi.spyOn(Tenant.prototype, "save").mockRejectedValueOnce(
      new Error("fixture tenant write failed"),
    );
    await expect(
      sync({
        stripeSubscription: snapshot({ status: "past_due", plan: "starter" }),
        eventCreatedAt: baseTime + 1,
        paymentRecovery: failed,
      }),
    ).rejects.toThrow("fixture tenant write failed");
    expect(await Subscription.findById(local._id).lean()).toEqual(original);
    expect((await Tenant.findById(tenantId))?.plan).toBe("professional");
    expect(emitWorkspaceNotificationEvent).not.toHaveBeenCalled();
  });
});
