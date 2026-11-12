import { describe, expect, it } from "vitest";

import { getStripeConnectWebhookConfigurationError } from "@/config/env.rules.js";

describe("environment configuration rules", () => {
  it("requires a dedicated Stripe Connect webhook secret in production", () => {
    expect(
      getStripeConnectWebhookConfigurationError({
        nodeEnv: "production",
        webhookSecret: "",
      }),
    ).toBe("STRIPE_CONNECT_WEBHOOK_SECRET is required in production.");
    expect(
      getStripeConnectWebhookConfigurationError({
        nodeEnv: "production",
        webhookSecret: "whsec_connect",
      }),
    ).toBeNull();
  });

  it("allows staged local and test startup without the Connect secret", () => {
    expect(
      getStripeConnectWebhookConfigurationError({
        nodeEnv: "development",
      }),
    ).toBeNull();
    expect(
      getStripeConnectWebhookConfigurationError({
        nodeEnv: "test",
      }),
    ).toBeNull();
  });
});

