import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  sync: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.stripe.service.js",
  () => ({
    getTenantBillingStripe: () => ({
      subscriptions: { retrieve: mocks.retrieve },
    }),
  }),
);
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.sync.service.js",
  () => ({ syncStripeSubscriptionSnapshotWithResult: mocks.sync }),
);
vi.mock(
  "@/modules/tenant-subscription/tenant-subscription.stripe-contract.js",
  () => ({ assertStripeSubscriptionContract: vi.fn() }),
);
vi.mock(
  "@/modules/tenant-subscription/tenant-subscription.webhook-event.repository.js",
  () => ({
    claimStripeWebhookEvent: mocks.claim,
    completeStripeWebhookEvent: mocks.complete,
    failStripeWebhookEvent: mocks.fail,
  }),
);
vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.email.service.js",
  () => ({ enqueueTenantBillingEmail: mocks.enqueue }),
);

import { handleTenantBillingEvent } from "@/modules/tenant-subscription/services/tenant-subscription.webhook.service.js";

const event = (type: string, object: Record<string, unknown>) =>
  ({
    id: "evt_fixture",
    created: 1000,
    type,
    data: { object },
  }) as unknown as Stripe.Event;
const completion = () =>
  event("checkout.session.completed", {
    id: "cs_fixture",
    mode: "subscription",
    subscription: "sub_fixture",
    customer: "cus_fixture",
    metadata: { tenantId: "tenant_fixture" },
    client_reference_id: "tenant_fixture",
  });

describe("signed tenant webhook binding and notification decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(true);
    mocks.retrieve.mockResolvedValue({ id: "sub_fixture" });
    mocks.sync.mockResolvedValue({
      subscription: { _id: "local_fixture" },
      hadPaymentFailure: false,
      paymentEventApplied: false,
    });
  });

  it("supplies completed Checkout identity only for the matching subscription Session", async () => {
    await handleTenantBillingEvent(completion());
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        completedCheckout: {
          id: "cs_fixture",
          subscriptionId: "sub_fixture",
          customerId: "cus_fixture",
          tenantId: "tenant_fixture",
        },
      }),
    );
    expect(mocks.complete).toHaveBeenCalledWith("evt_fixture");
  });

  it("rejects a Checkout whose client reference differs from its tenant metadata", async () => {
    const input = completion();
    (input.data.object as Stripe.Checkout.Session).client_reference_id =
      "tenant_other";
    await expect(handleTenantBillingEvent(input)).rejects.toThrow(
      /workspace identity/,
    );
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith("evt_fixture", expect.any(Error));
  });

  it("subscription.created cannot authorize binding before Checkout completes", async () => {
    await handleTenantBillingEvent(
      event("customer.subscription.created", { id: "sub_fixture" }),
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({ completedCheckout: undefined }),
    );
  });

  it("recovers an early failed invoice only when completed Checkout is successfully bound", async () => {
    const invoice = {
      id: "in_early",
      subscription: "sub_fixture",
      status: "open",
      attempt_count: 1,
      hosted_invoice_url: "https://invoice.stripe.com/fixture",
      next_payment_attempt: 2000,
    };
    await handleTenantBillingEvent(event("invoice.payment_failed", invoice));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    mocks.retrieve.mockResolvedValue({
      id: "sub_fixture",
      latest_invoice: invoice,
    });
    mocks.sync.mockResolvedValue({
      subscription: { _id: "local_fixture" },
      hadPaymentFailure: false,
      paymentEventApplied: true,
    });
    await handleTenantBillingEvent(completion());
    expect(mocks.retrieve).toHaveBeenLastCalledWith(
      "sub_fixture",
      expect.objectContaining({
        expand: expect.arrayContaining(["latest_invoice"]),
      }),
    );
    expect(mocks.sync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        latestInvoiceId: "in_early",
        paymentRecovery: expect.objectContaining({
          state: "failed",
          recoveryUrl: "https://invoice.stripe.com/fixture",
          nextPaymentAttemptAt: new Date(2000 * 1000),
        }),
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith({
      subscription: { _id: "local_fixture" },
      intent: expect.objectContaining({
        type: "payment_failed",
        deliveryKey: "tenant-billing:invoice:in_early:payment-attention",
      }),
    });
  });

  it("does not emit recovery email from a retired Checkout's expanded invoice", async () => {
    mocks.retrieve.mockResolvedValue({
      id: "sub_fixture",
      latest_invoice: { id: "in_old", status: "open", attempt_count: 1 },
    });
    await handleTenantBillingEvent(completion());
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("an ignored obsolete invoice does not enqueue a billing email", async () => {
    await handleTenantBillingEvent(
      event("invoice.payment_failed", {
        id: "in_fixture",
        subscription: "sub_fixture",
        attempt_count: 1,
        status: "open",
      }),
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        completedCheckout: undefined,
        paymentRecovery: expect.objectContaining({ state: "failed" }),
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("uses the transaction's prior failure state for a recovered-payment email", async () => {
    mocks.sync.mockResolvedValue({
      subscription: { _id: "local_fixture" },
      hadPaymentFailure: true,
      paymentEventApplied: true,
    });
    await handleTenantBillingEvent(
      event("invoice.paid", {
        id: "in_fixture",
        subscription: "sub_fixture",
        attempt_count: 2,
        status: "paid",
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith({
      subscription: { _id: "local_fixture" },
      intent: expect.objectContaining({ type: "payment_recovered" }),
    });
  });
});
