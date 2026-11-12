import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2E_STRIPE_ACCOUNT_ID,
  E2E_STRIPE_KEY,
  installE2EStripeTransport,
} from "../../e2e/support/e2e-stripe-transport.js";

describe("isolated E2E Stripe transport", () => {
  let restore: (() => void) | undefined;
  let externalRequest: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_TEST_MODE", "true");
    vi.stubEnv("STRIPE_KEY", E2E_STRIPE_KEY);
    // A regression must fail locally, never accidentally contact real Stripe.
    externalRequest = vi
      .spyOn(
        Object.getPrototypeOf(Stripe.createNodeHttpClient()),
        "makeRequest",
      )
      .mockRejectedValue(new Error("External Stripe transport was reached."));
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    expect(externalRequest).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("retrieves the seeded ready account through the real Stripe SDK without external IO", async () => {
    restore = installE2EStripeTransport();
    const stripe = new Stripe(E2E_STRIPE_KEY, { maxNetworkRetries: 0 });
    const account = await stripe.accounts.retrieve(E2E_STRIPE_ACCOUNT_ID);
    expect(account).toMatchObject({
      id: E2E_STRIPE_ACCOUNT_ID,
      object: "account",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      livemode: false,
      country: "CZ",
      default_currency: "eur",
    });
    expect(account.lastResponse.statusCode).toBe(200);
  });

  it.each([
    ["NODE_ENV", "production"],
    ["NODE_ENV", "development"],
    ["E2E_TEST_MODE", "false"],
    ["STRIPE_KEY", "sk_live_not_a_real_key"],
    ["STRIPE_KEY", "sk_test_another_key"],
  ])("refuses installation when %s is %s", (key, value) => {
    vi.stubEnv(key, value);
    expect(installE2EStripeTransport).toThrow("isolated E2E environment");
  });

  it("fails closed for another account and payment writes without falling back to real Stripe", async () => {
    restore = installE2EStripeTransport();
    const stripe = new Stripe(E2E_STRIPE_KEY, { maxNetworkRetries: 0 });
    await expect(
      stripe.accounts.retrieve("acct_unconfigured"),
    ).rejects.toThrow();
    await expect(
      stripe.paymentIntents.create({ amount: 100, currency: "eur" }),
    ).rejects.toThrow();
  });

  it("rejects a live credential even if a different Stripe client is created after installation", async () => {
    restore = installE2EStripeTransport();
    const stripe = new Stripe("sk_live_not_a_real_key", {
      maxNetworkRetries: 0,
    });
    await expect(
      stripe.accounts.retrieve(E2E_STRIPE_ACCOUNT_ID),
    ).rejects.toThrow();
  });

  it("rechecks isolation at request time and restores the prior transport on cleanup", async () => {
    restore = installE2EStripeTransport();
    expect(installE2EStripeTransport).toThrow("already installed");
    vi.stubEnv("NODE_ENV", "production");
    const stripe = new Stripe(E2E_STRIPE_KEY, { maxNetworkRetries: 0 });
    await expect(
      stripe.accounts.retrieve(E2E_STRIPE_ACCOUNT_ID),
    ).rejects.toThrow();
    restore();
    restore = undefined;
    expect(
      Object.getPrototypeOf(Stripe.createNodeHttpClient()).makeRequest,
    ).toBe(externalRequest);
  });
});
