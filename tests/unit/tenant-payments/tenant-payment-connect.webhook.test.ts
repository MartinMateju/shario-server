import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  findTenantPaymentAccountByStripeAccount: vi.fn(),
  updateTenantPaymentAccountFromWebhook: vi.fn(),
}));

const commerce = vi.hoisted(() => ({
  handleTenantPaymentCommerceEvent: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => repository,
);
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-commerce-event.service.js",
  () => commerce,
);

import { handleTenantPaymentConnectEvent } from "@/modules/tenant-payments/services/tenant-payment-connect.webhook.service.js";

const originalStripeKey = process.env.STRIPE_KEY;

const makeEvent = ({
  type = "account.updated",
  eventAccount = "acct_connected",
  livemode = false,
  object,
}: {
  type?: string;
  eventAccount?: string | null;
  livemode?: boolean;
  object?: Record<string, unknown>;
} = {}): Stripe.Event =>
  ({
    id: "evt_connect_test",
    object: "event",
    api_version: "2023-10-16",
    created: 1_700_000_000,
    data: {
      object:
        object ??
        ({
          id: "acct_connected",
          object: "account",
          country: "CZ",
          default_currency: "czk",
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: {
            currently_due: [],
            eventually_due: [],
            past_due: [],
            pending_verification: [],
            disabled_reason: null,
          },
        } as Record<string, unknown>),
    },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    ...(eventAccount ? { account: eventAccount } : {}),
  }) as Stripe.Event;

afterEach(() => {
  process.env.STRIPE_KEY = originalStripeKey;
  vi.clearAllMocks();
});

describe("Stripe Connect webhook dispatcher", () => {
  it("rejects events whose mode differs from the platform key", async () => {
    process.env.STRIPE_KEY = "sk_test_example";

    await expect(
      handleTenantPaymentConnectEvent(makeEvent({ livemode: true })),
    ).rejects.toMatchObject({ code: "STRIPE_CONNECT_MODE_MISMATCH" });
    expect(
      repository.updateTenantPaymentAccountFromWebhook,
    ).not.toHaveBeenCalled();
  });

  it("maps account.updated only through the persisted Stripe account id", async () => {
    process.env.STRIPE_KEY = "sk_test_example";
    repository.updateTenantPaymentAccountFromWebhook.mockResolvedValue({
      stripeAccountId: "acct_connected",
    });

    await handleTenantPaymentConnectEvent(makeEvent());

    expect(repository.updateTenantPaymentAccountFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: "acct_connected",
        eventCreated: 1_700_000_000,
      }),
    );
    expect(
      repository.findTenantPaymentAccountByStripeAccount,
    ).not.toHaveBeenCalled();
  });

  it("rejects a mismatched event account before changing ownership state", async () => {
    process.env.STRIPE_KEY = "sk_test_example";

    await expect(
      handleTenantPaymentConnectEvent(
        makeEvent({ eventAccount: "acct_different" }),
      ),
    ).rejects.toMatchObject({
      code: "STRIPE_CONNECT_ACCOUNT_CONTEXT_MISMATCH",
    });
    expect(
      repository.updateTenantPaymentAccountFromWebhook,
    ).not.toHaveBeenCalled();
  });

  it("acknowledges an unknown account without trusting webhook metadata", async () => {
    process.env.STRIPE_KEY = "sk_test_example";
    repository.updateTenantPaymentAccountFromWebhook.mockResolvedValue(null);
    repository.findTenantPaymentAccountByStripeAccount.mockResolvedValue(null);

    await expect(handleTenantPaymentConnectEvent(makeEvent())).resolves.toBe(
      undefined,
    );
    expect(
      repository.findTenantPaymentAccountByStripeAccount,
    ).toHaveBeenCalledWith("acct_connected");
  });

  it("acknowledges unsupported non-commerce events", async () => {
    process.env.STRIPE_KEY = "sk_test_example";

    await expect(
      handleTenantPaymentConnectEvent(
        makeEvent({
          type: "capability.updated",
          object: { id: "card_payments", object: "capability" },
        }),
      ),
    ).resolves.toBe(undefined);
    expect(commerce.handleTenantPaymentCommerceEvent).not.toHaveBeenCalled();
  });

  it("forwards verified connected-account commerce events once", async () => {
    process.env.STRIPE_KEY = "sk_test_example";
    const event = makeEvent({
      type: "checkout.session.completed",
      object: { id: "cs_test", object: "checkout.session" },
    });

    await handleTenantPaymentConnectEvent(event);

    expect(commerce.handleTenantPaymentCommerceEvent).toHaveBeenCalledOnce();
    expect(commerce.handleTenantPaymentCommerceEvent).toHaveBeenCalledWith(event);
  });
});

