import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/env.rules.js", () => ({
  getStripeConnectWebhookConfigurationError: () => null,
}));

vi.mock("@/config/r2-env.js", () => ({
  addR2EnvironmentIssues: () => undefined,
  r2EnvironmentShape: {},
}));

vi.mock("dotenv/config", () => ({}));

const originalEnvironment = { ...process.env };

const BASE_ENVIRONMENT: Record<string, string> = {
  NODE_ENV: "test",
  SERVER_URL: "http://api.shario.localhost:4000",
  CLIENT_URL: "http://shario.localhost:3000",
  MONGO_URI: "mongodb://127.0.0.1:27017/shario-test",
  REDIS_URL: "redis://127.0.0.1:6379",
  ACCESS_TOKEN_SECRET: "access-token-secret-with-thirty-two-bytes",
  REFRESH_TOKEN_SECRET: "refresh-token-secret-with-thirty-two-bytes",
  AUTH_EMAIL: "auth@example.com",
  EMAIL_USER: "mail@example.com",
  EMAIL_PASSWORD: "password",
  EMAIL_SECRET_KEY: "email-secret-key-long-enough",
  COMMUNICATION_SCHEDULER_INTERVAL_MS: "60000",
  STRIPE_KEY: "sk_test_example",
  WEBHOOK_SECRET: "whsec_example",
};

const loadEnvironment = async (
  overrides: Record<string, string | undefined> = {},
) => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }

  Object.assign(process.env, BASE_ENVIRONMENT);

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  return import("@/config/env.js");
};

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  vi.resetModules();
});

describe("custom-domain authentication environment", () => {
  const proxySecret = "proxy-secret-with-at-least-thirty-two-bytes";
  const handoffSecret = "handoff-secret-with-at-least-thirty-two-bytes";

  it("allows the optional feature to remain disabled", async () => {
    const { env } = await loadEnvironment();

    expect(env).not.toHaveProperty("AUTH_FIRST_PARTY_PROXY_SECRET");
    expect(env).not.toHaveProperty("AUTH_SESSION_HANDOFF_SECRET");
  });

  it("accepts a complete pair of independent secrets", async () => {
    await expect(
      loadEnvironment({
        AUTH_FIRST_PARTY_PROXY_SECRET: proxySecret,
        AUTH_SESSION_HANDOFF_SECRET: handoffSecret,
      }),
    ).resolves.toMatchObject({
      env: {
        AUTH_FIRST_PARTY_PROXY_SECRET: proxySecret,
        AUTH_SESSION_HANDOFF_SECRET: handoffSecret,
      },
    });
  });

  it.each([
    ["proxy", proxySecret, undefined],
    ["handoff", undefined, handoffSecret],
  ])(
    "rejects an incomplete %s-only configuration",
    async (_label, proxy, handoff) => {
      await expect(
        loadEnvironment({
          AUTH_FIRST_PARTY_PROXY_SECRET: proxy,
          AUTH_SESSION_HANDOFF_SECRET: handoff,
        }),
      ).rejects.toThrow("requires both proxy and handoff secrets");
    },
  );

  it("rejects short or reused key material", async () => {
    await expect(
      loadEnvironment({
        AUTH_FIRST_PARTY_PROXY_SECRET: "short",
        AUTH_SESSION_HANDOFF_SECRET: handoffSecret,
      }),
    ).rejects.toThrow(
      "AUTH_FIRST_PARTY_PROXY_SECRET must contain at least 32 bytes",
    );

    await expect(
      loadEnvironment({
        AUTH_FIRST_PARTY_PROXY_SECRET: proxySecret,
        AUTH_SESSION_HANDOFF_SECRET: proxySecret,
      }),
    ).rejects.toThrow(
      "AUTH_SESSION_HANDOFF_SECRET must be different from AUTH_FIRST_PARTY_PROXY_SECRET",
    );

    await expect(
      loadEnvironment({
        AUTH_FIRST_PARTY_PROXY_SECRET: BASE_ENVIRONMENT.ACCESS_TOKEN_SECRET,
        AUTH_SESSION_HANDOFF_SECRET: handoffSecret,
      }),
    ).rejects.toThrow(
      "AUTH_FIRST_PARTY_PROXY_SECRET must be different from the JWT signing secrets",
    );
  });
});
