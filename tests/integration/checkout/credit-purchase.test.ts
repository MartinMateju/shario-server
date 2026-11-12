import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep real checkout persistence, signature verification, payment claims,
// credit transactions and customer status queries. No Stripe requests,
// invoices, notifications or unrelated product fulfillment leave this test.
vi.mock("@/modules/tenant-payments/services/tenant-payment-connect.service.js", () => ({
  requireReadyTenantConnectedAccount: vi.fn(),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({
  ensurePaidOrderInvoice: vi.fn(),
}));
vi.mock("@/modules/workspace-notifications/workspace-notification.business-events.js", () => ({
  emitBookingCreatedNotificationsForOrderSafely: vi.fn(),
}));
vi.mock("@/modules/membership/services/membership-webhook.service.js", () => ({
  handleMembershipStripeEvent: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  claimWaitlistOrderForWebhook: vi.fn().mockResolvedValue({ kind: "not_waitlist" }),
  expireWaitlistOrderAfterStripeSession: vi.fn().mockResolvedValue(null),
  reconcileWaitlistAfterDirectCourseBooking: vi.fn(),
}));

import { Cart } from "@/modules/cart/cart.model.js";
import { Order } from "@/modules/order/order.model.js";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import TenantPaymentAccount from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { creditCheckoutService } from "@/modules/money-credit/services/credit-checkout.service.js";
import { purchaseCreditsSchema } from "@/modules/money-credit/money-credit.validators.js";
import { ALLOWED_CREDIT_PURCHASE_AMOUNTS } from "@/modules/money-credit/money-credit.constants.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { requireReadyTenantConnectedAccount } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";
import {
  constructTenantPaymentConnectEvent,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { handleTenantPaymentConnectEvent } from "@/modules/tenant-payments/services/tenant-payment-connect.webhook.service.js";

const tenantId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const accountId = "acct_credit_purchase_test";
const secret = "whsec_credit_purchase_test";
const models = [Cart, Order, User, Tenant, TenantPaymentAccount, MoneyCredit];
let replicaSet: MongoMemoryReplSet;
let createSession: ReturnType<typeof vi.spyOn>;
let expireSession: ReturnType<typeof vi.spyOn>;

const purchase = (input: Record<string, unknown> = {}) =>
  creditCheckoutService.createCreditPurchaseCheckout(
    String(tenantId),
    String(userId),
    purchaseCreditsSchema.parse({
      amount: 500,
      locale: "en",
      locationReference: "vaclavska",
      ...input,
    }),
  );

const eventFor = (
  checkout: { sessionId: string; orderId: string },
  sessionOverrides: Record<string, unknown> = {},
  eventOverrides: Record<string, unknown> = {},
) => ({
  id: `evt_${checkout.sessionId}`,
  object: "event",
  type: "checkout.session.completed",
  account: accountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: checkout.sessionId,
      object: "checkout.session",
      client_reference_id: checkout.orderId,
      status: "complete",
      payment_status: "paid",
      payment_intent: `pi_${checkout.sessionId}`,
      amount_total: 50_000,
      currency: "czk",
      livemode: false,
      metadata: {
        sharioManaged: "true",
        sharioFlow: "credit-purchase",
        orderType: "credit-purchase",
        orderId: checkout.orderId,
        tenantId: String(tenantId),
        userId: String(userId),
      },
      ...sessionOverrides,
    },
  },
  ...eventOverrides,
});

const deliver = async (event: ReturnType<typeof eventFor>, signingSecret = secret) => {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: signingSecret,
  });
  const verified = constructTenantPaymentConnectEvent(Buffer.from(payload), signature);
  await handleTenantPaymentConnectEvent(verified);
};

const customerStatus = (orderId: string, ownerId = userId, workspaceId = tenantId) =>
  checkoutRepository.findCustomerOrderStatus({
    tenantId: String(workspaceId),
    userId: String(ownerId),
    orderId,
  });

const expectBalance = async (balanceMinor: number, transactionCount: number) => {
  expect(await User.findById(userId).lean()).toMatchObject({
    moneyCredits: balanceMinor / 100,
    moneyCreditsMinor: balanceMinor,
  });
  const ledger = await MoneyCredit.findOne({ tenant: tenantId, user: userId }).lean();
  if (transactionCount === 0) {
    expect(ledger).toBeNull();
  } else {
    expect(ledger).toMatchObject({
      balance: balanceMinor / 100,
      balanceMinor,
      currency: "CZK",
    });
    expect(ledger?.transactions).toHaveLength(transactionCount);
  }
};

describe("credit purchase checkout and signed paid webhook", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", "sk_test_credit_purchase");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", secret);
    vi.stubEnv("DEVELOPMENT_ROOT_DOMAIN", "localhost");
    vi.stubEnv("CLIENT_URL", "http://shario.localhost:3000");
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri(), { autoIndex: false });
    await Promise.all(models.map((model) => model.createCollection()));
    await MoneyCredit.createIndexes();
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({
      _id: tenantId,
      slug: "credit-studio",
      settings: { currency: "CZK", defaultLanguage: "cs" },
    } as never);
    await User.collection.insertMany([
      {
        _id: userId,
        tenant: tenantId,
        firstname: "Credit",
        lastname: "Buyer",
        email: "buyer@example.test",
        moneyCredits: 7.25,
        moneyCreditsMinor: 725,
      },
      {
        _id: otherUserId,
        tenant: otherTenantId,
        firstname: "Other",
        email: "other@example.test",
        moneyCredits: 0,
        moneyCreditsMinor: 0,
      },
    ] as never);
    await TenantPaymentAccount.collection.insertOne({
      tenant: tenantId,
      stripeAccountId: accountId,
    } as never);
    vi.mocked(requireReadyTenantConnectedAccount).mockResolvedValue({
      stripeAccountId: accountId,
    } as never);
    createSession = vi.spyOn(getTenantPaymentStripe().checkout.sessions, "create")
      .mockImplementation(async (...args: unknown[]) => {
        const params = args[0] as Stripe.Checkout.SessionCreateParams;
        const order = await Order.findById(params.client_reference_id).lean();
        expect(order).toMatchObject({ status: "pending_order", isPaid: false });
        return {
          id: `cs_credit_${params.client_reference_id}`,
          url: `https://checkout.stripe.com/test/${params.client_reference_id}`,
          livemode: false,
        } as never;
      });
    expireSession = vi.spyOn(getTenantPaymentStripe().checkout.sessions, "expire")
      .mockResolvedValue({} as never);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replicaSet?.stop();
    vi.unstubAllEnvs();
  });

  it.each(ALLOWED_CREDIT_PURCHASE_AMOUNTS)(
    "persists a %s CZK pending purchase before creating its connected-account session",
    async (amount) => {
      const checkout = await purchase({ amount });
      const [payload, options] = createSession.mock.calls[0];
      expect(options).toMatchObject({
        stripeAccount: accountId,
        idempotencyKey: `credit-purchase-session:${checkout.orderId}`,
      });
      expect(payload).toMatchObject({
        mode: "payment",
        customer_email: "buyer@example.test",
        client_reference_id: checkout.orderId,
        line_items: [{ quantity: 1, price_data: { currency: "czk", unit_amount: amount * 100 } }],
      });
      expect(await Order.findById(checkout.orderId).lean()).toMatchObject({
        tenant: tenantId,
        createdBy: userId,
        currency: "CZK",
        expectedAmountMinor: amount * 100,
        creditPurchase: { amount, currency: "CZK" },
        stripe: { sessionId: checkout.sessionId, connectedAccountId: accountId, livemode: false },
      });
      const success = new URL(payload.success_url);
      const cancel = new URL(payload.cancel_url);
      expect(success.pathname).toBe("/en/portal/credits/purchase-success");
      expect(success.searchParams.get("orderId")).toBe(checkout.orderId);
      expect(success.searchParams.get("location")).toBe("vaclavska");
      expect(cancel.pathname).toBe("/en/portal/credits/cancel");
      expect(cancel.searchParams.get("location")).toBe("vaclavska");
      expect(await customerStatus(checkout.orderId)).toMatchObject({
        status: "pending_order", isPaid: false,
      });
      await expectBalance(725, 0);
    },
  );

  it("uses the workspace currency and safe origin, with backward-compatible return context", async () => {
    await Tenant.collection.updateOne({ _id: tenantId }, { $set: { "settings.currency": "EUR" } });
    await purchase({ currency: "eur", locale: "cs", origin: "https://evil.example", locationReference: undefined });
    const [payload] = createSession.mock.calls[0];
    expect(payload.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 50_000 });
    expect(new URL(payload.success_url).origin).toBe("http://credit-studio.localhost:3000");
    expect(new URL(payload.success_url).pathname).toBe("/cs/portal/credits/purchase-success");
    expect(new URL(payload.success_url).searchParams.has("location")).toBe(false);
    expect(new URL(payload.cancel_url).searchParams.has("location")).toBe(false);
  });

  it("rejects another tenant's customer and mismatched currency before creating a payable session", async () => {
    await expect(creditCheckoutService.createCreditPurchaseCheckout(
      String(tenantId), String(otherUserId), { amount: 500 },
    )).rejects.toThrow("Authenticated user was not found");
    await expect(purchase({ currency: "EUR" })).rejects.toMatchObject({
      code: "CREDIT_CURRENCY_MISMATCH",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(await Order.countDocuments()).toBe(0);
    expect(await Cart.countDocuments()).toBe(0);
  });

  it("expires an unattachable session and never returns its payment URL", async () => {
    vi.spyOn(checkoutRepository, "attachStripeSession").mockResolvedValueOnce({ modifiedCount: 0 } as never);
    await expect(purchase()).rejects.toThrow("could not be attached");
    expect(expireSession).toHaveBeenCalledWith(expect.stringMatching(/^cs_credit_/), {
      stripeAccount: accountId,
    });
    await expectBalance(725, 0);
  });

  it("rejects an invalid webhook signature without credit or order mutation", async () => {
    const checkout = await purchase();
    await expect(deliver(eventFor(checkout), "whsec_wrong")).rejects.toThrow();
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: false });
    await expectBalance(725, 0);
  });

  it("waits for payment and cancels expired unpaid sessions without adding credits", async () => {
    const checkout = await purchase();
    await deliver(eventFor(checkout, { payment_status: "unpaid" }));
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: false });
    await deliver(eventFor(checkout, { status: "expired", payment_status: "unpaid" }, {
      type: "checkout.session.expired",
    }));
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "cancelled_order", isPaid: false });
    await expectBalance(725, 0);
  });

  it.each([
    { payment_status: undefined },
    { status: undefined },
    { status: "open" },
  ])("requires explicit paid and complete proof for a credit purchase: %j", async (override) => {
    const checkout = await purchase();
    await expect(deliver(eventFor(checkout, override))).rejects.toThrow("completed and paid");
    await expectBalance(725, 0);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: false });
  });

  it("never treats a no-payment-required session as payment for positive-value credits", async () => {
    const checkout = await purchase();
    await deliver(eventFor(checkout, { payment_status: "no_payment_required" }));
    await expectBalance(725, 0);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: false });
  });

  it("adds paid credits exactly once across repeated and distinct event deliveries", async () => {
    const checkout = await purchase();
    const event = eventFor(checkout);
    // Account/session/order binding is authoritative, never a metadata user.
    event.data.object.metadata.userId = String(otherUserId);
    await deliver(event);
    await deliver(event);
    await deliver({ ...event, id: "evt_same_session_again", type: "checkout.session.async_payment_succeeded" });
    await expectBalance(50_725, 1);
    expect(await customerStatus(checkout.orderId)).toMatchObject({
      status: "processed_order", isPaid: true, paidAmountMinor: 50_000,
    });
    expect(await customerStatus(checkout.orderId, otherUserId)).toBeNull();
    expect(await customerStatus(checkout.orderId, userId, otherTenantId)).toBeNull();
    expect(await User.findById(otherUserId).lean()).toMatchObject({ moneyCreditsMinor: 0 });
    expect((await MoneyCredit.findOne({ user: userId }).lean())?.transactions[0]).toMatchObject({
      type: "added",
      amountMinor: 50_000,
      relatedOrder: new mongoose.Types.ObjectId(checkout.orderId),
      idempotencyKey: `checkout-credit-purchase:${checkout.orderId}`,
    });
  });

  it("survives concurrent deliveries without granting a purchase twice", async () => {
    const checkout = await purchase();
    const event = eventFor(checkout);
    const results = await Promise.allSettled([deliver(event), deliver({ ...event, id: "evt_concurrent" })]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    // A busy lease deliberately asks Stripe to retry rather than losing delivery.
    await deliver(event);
    await expectBalance(50_725, 1);
  });

  it("serializes two legitimate simultaneous purchases into the same credit balance", async () => {
    const first = await purchase();
    const second = await purchase();
    await Promise.all([deliver(eventFor(first)), deliver(eventFor(second))]);
    await expectBalance(100_725, 2);
  });

  it("rolls back a failed ledger write and fulfills the paid pending order on retry", async () => {
    const checkout = await purchase();
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(new Error("ledger temporarily unavailable"));
    await expect(deliver(eventFor(checkout))).rejects.toThrow("ledger temporarily unavailable");
    await expectBalance(725, 0);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: true });
    await deliver(eventFor(checkout));
    await expectBalance(50_725, 1);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "processed_order", isPaid: true });
  });

  it("resumes after a crash between committed credits and final order status without regranting", async () => {
    const checkout = await purchase();
    vi.spyOn(checkoutRepository, "markOrderProcessed").mockRejectedValueOnce(new Error("order update unavailable"));
    await expect(deliver(eventFor(checkout))).rejects.toThrow("order update unavailable");
    await expectBalance(50_725, 1);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: true });
    await deliver(eventFor(checkout));
    await expectBalance(50_725, 1);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "processed_order", isPaid: true });
  });

  it.each([
    { amount_total: 49_999 },
    { currency: "eur" },
    { id: "cs_different" },
    { livemode: true },
  ])("rejects a signed session inconsistent with its durable order: %j", async (override) => {
    const checkout = await purchase();
    await expect(deliver(eventFor(checkout, override))).rejects.toThrow();
    await expectBalance(725, 0);
    expect((await customerStatus(checkout.orderId))?.isPaid).toBe(false);
  });

  it("rejects connected-account and tenant metadata mismatches before fulfillment", async () => {
    const checkout = await purchase();
    await expect(deliver(eventFor(checkout, {}, { account: "acct_other" }))).rejects.toThrow("does not belong");
    const event = eventFor(checkout);
    event.data.object.metadata.tenantId = String(otherTenantId);
    await expect(deliver(event)).rejects.toThrow("does not belong");
    await expectBalance(725, 0);
    expect(await customerStatus(checkout.orderId)).toMatchObject({ status: "pending_order", isPaid: false });
  });
});
