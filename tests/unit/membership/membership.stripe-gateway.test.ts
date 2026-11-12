import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
  listSessions: vi.fn(),
  retrieveSubscription: vi.fn(),
  retrieveInvoice: vi.fn(),
  listInvoices: vi.fn(),
  requestOptions: vi.fn(
    (connectedAccountId: string, options: Record<string, unknown> = {}) => ({
      ...options,
      stripeAccount: connectedAccountId,
    }),
  ),
}));

vi.mock(
  "@/modules/tenant-payments/tenant-payment.stripe.gateway.js",
  () => ({
    getTenantPaymentStripe: () => ({
      checkout: { sessions: {
        create: stripeMocks.createSession,
        retrieve: stripeMocks.retrieveSession,
        list: stripeMocks.listSessions,
      } },
      subscriptions: { retrieve: stripeMocks.retrieveSubscription },
      invoices: {
        retrieve: stripeMocks.retrieveInvoice,
        list: stripeMocks.listInvoices,
      },
    }),
    getConnectedAccountRequestOptions: stripeMocks.requestOptions,
  }),
);

import {
  MEMBERSHIP_STRIPE_FLOW,
  createMembershipCheckoutSession,
  findMembershipCheckoutSession,
  listMembershipSubscriptionInvoices,
  retrieveMembershipCheckoutSession,
  retrieveMembershipInvoice,
  retrieveMembershipSubscription,
} from "@/modules/membership/membership.stripe.gateway.js";

const baseInput = {
  connectedAccountId: "acct_tenant_123",
  idempotencyKey: "membership-checkout-0001",
  membershipId: "mem_123",
  tenantId: "tenant_123",
  userId: "user_123",
  userEmail: "member@example.com",
  planId: "plan_123",
  planVersionId: "version_123",
  name: "Studio Pass",
  description: "Ten visits per billing period",
  currency: "CZK",
  amountMinor: 12_900,
  successUrl: "https://studio.example/membership/success",
  cancelUrl: "https://studio.example/membership/cancel",
  expiresAt: Math.floor(new Date("2026-07-23T12:31:00.000Z").getTime() / 1000),
};

describe("membership Stripe gateway", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    stripeMocks.createSession.mockReset().mockResolvedValue({ id: "cs_test_membership" });
    stripeMocks.retrieveSession.mockReset().mockResolvedValue({ id: "cs_test_membership" });
    stripeMocks.listSessions.mockReset().mockResolvedValue({ data: [], has_more: false });
    stripeMocks.retrieveSubscription.mockReset().mockResolvedValue({ id: "sub_membership" });
    stripeMocks.retrieveInvoice.mockReset().mockResolvedValue({ id: "in_membership" });
    stripeMocks.listInvoices.mockReset().mockResolvedValue({ data: [], has_more: false });
    stripeMocks.requestOptions.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates recurring Checkout only in the tenant connected-account context", async () => {
    await createMembershipCheckoutSession({
      ...baseInput,
      billing: { type: "recurring", interval: "month", intervalCount: 2 },
    });

    expect(stripeMocks.requestOptions).toHaveBeenCalledWith(
      "acct_tenant_123",
      { idempotencyKey: "membership-checkout-0001" },
    );
    const [params, options] = stripeMocks.createSession.mock.calls[0];
    expect(options).toEqual({
      stripeAccount: "acct_tenant_123",
      idempotencyKey: "membership-checkout-0001",
    });
    expect(params).toMatchObject({
      mode: "subscription",
      client_reference_id: "mem_123",
      metadata: {
        sharioFlow: MEMBERSHIP_STRIPE_FLOW,
        sharioTenantId: "tenant_123",
        sharioMembershipId: "mem_123",
        sharioUserId: "user_123",
        sharioPlanId: "plan_123",
        sharioPlanVersionId: "version_123",
      },
      line_items: [{
        price_data: {
          currency: "czk",
          unit_amount: 12_900,
          recurring: { interval: "month", interval_count: 2 },
        },
      }],
      subscription_data: {
        metadata: { sharioFlow: MEMBERSHIP_STRIPE_FLOW, sharioMembershipId: "mem_123" },
      },
    });
    expect(params.expires_at).toBe(Math.floor(Date.now() / 1000) + 31 * 60);
    expect(params).not.toHaveProperty("payment_intent_data");
    expect(params).not.toHaveProperty("invoice_creation");
  });

  it("creates fixed Checkout as a one-time payment with invoice creation", async () => {
    await createMembershipCheckoutSession({
      ...baseInput,
      billing: { type: "fixed", durationDays: 90 },
    });

    const [params, options] = stripeMocks.createSession.mock.calls[0];
    expect(options).toEqual({
      stripeAccount: "acct_tenant_123",
      idempotencyKey: "membership-checkout-0001",
    });
    expect(params).toMatchObject({
      mode: "payment",
      customer_creation: "always",
      payment_intent_data: {
        metadata: { sharioFlow: MEMBERSHIP_STRIPE_FLOW, sharioMembershipId: "mem_123" },
      },
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: { sharioFlow: MEMBERSHIP_STRIPE_FLOW, sharioMembershipId: "mem_123" },
        },
      },
    });
    expect(params.line_items[0].price_data).not.toHaveProperty("recurring");
    expect(params).not.toHaveProperty("subscription_data");
  });

  it("replays identical Stripe parameters after an interrupted create even when time advances", async () => {
    const input = { ...baseInput, billing: { type: "recurring", interval: "month", intervalCount: 1 } };
    await createMembershipCheckoutSession(input);
    const original = structuredClone(stripeMocks.createSession.mock.calls[0]);
    vi.setSystemTime(new Date(Date.now() + 5_000));
    await createMembershipCheckoutSession(input);
    expect(stripeMocks.createSession.mock.calls[1]).toEqual(original);
    expect(stripeMocks.createSession.mock.calls[1][0].expires_at).toBe(baseInput.expiresAt);
  });

  it("requires a persisted deadline instead of inventing new idempotent request parameters", async () => {
    await expect(createMembershipCheckoutSession({
      ...baseInput, expiresAt: undefined, billing: { type: "recurring", interval: "month", intervalCount: 1 },
    })).rejects.toThrow(/persisted expiration/i);
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it("finds an interrupted Session across pages using the exact connected account and membership identity", async () => {
    const matching = {
      id: "cs_original", client_reference_id: baseInput.membershipId,
      metadata: { sharioFlow: MEMBERSHIP_STRIPE_FLOW, sharioTenantId: baseInput.tenantId, sharioMembershipId: baseInput.membershipId },
    };
    stripeMocks.listSessions
      .mockResolvedValueOnce({ data: [{ ...matching, id: "cs_other_tenant", metadata: { ...matching.metadata, sharioTenantId: "another_tenant" } }], has_more: true })
      .mockResolvedValueOnce({ data: [matching], has_more: false });
    stripeMocks.retrieveSession.mockResolvedValue({ ...matching, status: "complete", payment_status: "paid" });
    await expect(findMembershipCheckoutSession({
      connectedAccountId: baseInput.connectedAccountId, tenantId: baseInput.tenantId,
      membershipId: baseInput.membershipId, createdAt: new Date("2026-07-23T12:00:00.000Z"),
    })).resolves.toMatchObject({ id: "cs_original", payment_status: "paid" });
    expect(stripeMocks.listSessions).toHaveBeenNthCalledWith(1,
      { limit: 100, created: { gte: Math.floor(Date.now() / 1000) - 300 } },
      { stripeAccount: baseInput.connectedAccountId },
    );
    expect(stripeMocks.listSessions.mock.calls[1][0]).toMatchObject({ starting_after: "cs_other_tenant" });
    expect(stripeMocks.retrieveSession.mock.calls[0][0]).toBe("cs_original");
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it("does not guess when legacy recovery finds no Session or multiple matching Sessions", async () => {
    const input = { connectedAccountId: baseInput.connectedAccountId, tenantId: baseInput.tenantId, membershipId: baseInput.membershipId };
    await expect(findMembershipCheckoutSession(input)).resolves.toBeNull();
    const metadata = { sharioFlow: MEMBERSHIP_STRIPE_FLOW, sharioTenantId: baseInput.tenantId, sharioMembershipId: baseInput.membershipId };
    stripeMocks.listSessions.mockResolvedValue({ data: [
      { id: "cs_first", client_reference_id: baseInput.membershipId, metadata },
      { id: "cs_second", client_reference_id: baseInput.membershipId, metadata },
    ], has_more: false });
    await expect(findMembershipCheckoutSession(input)).rejects.toThrow(/Multiple Stripe Checkout sessions/);
    expect(stripeMocks.retrieveSession).not.toHaveBeenCalled();
  });

  it("rejects zero totals before calling Stripe", async () => {
    await expect(createMembershipCheckoutSession({
      ...baseInput,
      amountMinor: 0,
      billing: { type: "fixed", durationDays: 1 },
    })).rejects.toThrow(/positive minor-unit amount/i);
    expect(stripeMocks.createSession).not.toHaveBeenCalled();
  });

  it("retrieves and lists invoices only in the tenant connected-account context", async () => {
    await retrieveMembershipInvoice("acct_tenant_123", "in_membership");
    await listMembershipSubscriptionInvoices("acct_tenant_123", "sub_membership", 500);

    expect(stripeMocks.retrieveInvoice).toHaveBeenCalledWith(
      "in_membership",
      {},
      { stripeAccount: "acct_tenant_123" },
    );
    expect(stripeMocks.listInvoices).toHaveBeenCalledWith(
      { subscription: "sub_membership", limit: 100 },
      { stripeAccount: "acct_tenant_123" },
    );
  });

  it("retrieves expanded recovery state only in the tenant connected-account context", async () => {
    await retrieveMembershipCheckoutSession("acct_tenant_123", "cs_test_membership");
    await retrieveMembershipSubscription("acct_tenant_123", "sub_membership");

    expect(stripeMocks.retrieveSession).toHaveBeenCalledWith(
      "cs_test_membership",
      { expand: [
        "invoice",
        "payment_intent.latest_charge",
        "subscription.latest_invoice.payment_intent",
      ] },
      { stripeAccount: "acct_tenant_123" },
    );
    expect(stripeMocks.retrieveSubscription).toHaveBeenCalledWith(
      "sub_membership",
      { expand: ["latest_invoice.payment_intent"] },
      { stripeAccount: "acct_tenant_123" },
    );
  });
});
