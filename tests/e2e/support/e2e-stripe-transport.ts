import Stripe from "stripe";

export const E2E_STRIPE_KEY = "sk_test_e2e_no_external_requests";
export const E2E_STRIPE_ACCOUNT_ID = "acct_e2e_alpha_no_external_requests";

const assertFixtureEnvironment = () => {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.E2E_TEST_MODE !== "true" ||
    process.env.STRIPE_KEY !== E2E_STRIPE_KEY
  ) {
    throw new Error(
      "The Stripe fixture transport requires the isolated E2E environment and fake key.",
    );
  }
};

let installed = false;

/**
 * Installed only by the test bootstrap, never imported by production sources.
 * Keep the real SDK and application/auth routes; replace only its network
 * transport. Unknown requests fail closed instead of reaching real Stripe.
 */
export const installE2EStripeTransport = (): (() => void) => {
  assertFixtureEnvironment();
  if (installed)
    throw new Error("The Stripe fixture transport is already installed.");

  const prototype = Object.getPrototypeOf(
    Stripe.createNodeHttpClient(),
  ) as Stripe.HttpClient;
  const originalMakeRequest = prototype.makeRequest;
  prototype.makeRequest = async (
    host,
    port,
    path,
    method,
    headers,
    requestData,
    protocol,
  ) => {
    assertFixtureEnvironment();
    const authorization = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    )?.[1];
    if (
      host !== "api.stripe.com" ||
      String(port) !== "443" ||
      protocol !== "https" ||
      authorization !== `Bearer ${E2E_STRIPE_KEY}` ||
      method !== "GET" ||
      path !== `/v1/accounts/${E2E_STRIPE_ACCOUNT_ID}` ||
      Boolean(requestData)
    ) {
      throw new Error(
        "Unconfigured Stripe request blocked by the E2E fixture transport.",
      );
    }

    const account = {
      id: E2E_STRIPE_ACCOUNT_ID,
      object: "account",
      country: "CZ",
      default_currency: "eur",
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      livemode: false,
      controller: {
        fees: { payer: "account" },
        losses: { payments: "stripe" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "full" },
      },
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      },
    };
    const responseHeaders = {
      "content-type": "application/json",
      "request-id": "req_e2e_connect",
    };
    return {
      getStatusCode: () => 200,
      getHeaders: () => responseHeaders,
      getRawResponse: () => ({ statusCode: 200, headers: responseHeaders }),
      toJSON: async () => account,
      toStream: () => {
        throw new Error(
          "Streaming is not supported by the Stripe E2E fixture.",
        );
      },
    };
  };
  installed = true;
  return () => {
    prototype.makeRequest = originalMakeRequest;
    installed = false;
  };
};
