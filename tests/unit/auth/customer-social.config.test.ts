import { afterEach, describe, expect, it } from "vitest";

import { getCustomerSocialProviderAvailability } from "@/modules/auth/social/customer-social.config.js";
import { resolveCustomerSocialReturnOrigin } from "@/modules/auth/social/customer-social.service.js";

const KEYS = [
  "SERVER_URL",
  "CUSTOMER_SOCIAL_STATE_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "APPLE_OAUTH_CLIENT_ID",
  "APPLE_OAUTH_TEAM_ID",
  "APPLE_OAUTH_KEY_ID",
  "APPLE_OAUTH_PRIVATE_KEY",
  "APPLE_OAUTH_REDIRECT_URI",
] as const;

const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  KEYS.forEach((key) => {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  process.env.NODE_ENV = originalNodeEnv;
});

describe("customer social provider availability", () => {
  it("hides incomplete providers", () => {
    process.env.CUSTOMER_SOCIAL_STATE_SECRET = "x".repeat(40);
    process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.APPLE_OAUTH_CLIENT_ID;

    expect(getCustomerSocialProviderAvailability()).toEqual({
      google: false,
      apple: false,
    });
  });

  it("exposes only completely configured global providers", () => {
    process.env.SERVER_URL = "https://api.shario.io";
    process.env.CUSTOMER_SOCIAL_STATE_SECRET = "x".repeat(40);
    process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
    delete process.env.APPLE_OAUTH_CLIENT_ID;

    expect(getCustomerSocialProviderAvailability()).toEqual({
      google: true,
      apple: false,
    });
  });

  it("does not expose Apple until every signing credential is configured", () => {
    process.env.SERVER_URL = "https://api.shario.io";
    process.env.CUSTOMER_SOCIAL_STATE_SECRET = "x".repeat(40);
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.APPLE_OAUTH_CLIENT_ID = "com.shario.customer";
    process.env.APPLE_OAUTH_TEAM_ID = "apple-team";
    process.env.APPLE_OAUTH_KEY_ID = "apple-key";
    process.env.APPLE_OAUTH_PRIVATE_KEY = "private-key";

    expect(getCustomerSocialProviderAvailability()).toEqual({
      google: false,
      apple: true,
    });

    delete process.env.APPLE_OAUTH_KEY_ID;

    expect(getCustomerSocialProviderAvailability()).toEqual({
      google: false,
      apple: false,
    });
  });
});

describe("customer social tenant return origin", () => {
  it("accepts the standard and active custom tenant origins", () => {
    process.env.NODE_ENV = "production";

    const tenant = {
      slug: "studio-olivka",
      domains: [
        {
          hostname: "olivka.example",
          status: "active",
        },
      ],
    };

    expect(
      resolveCustomerSocialReturnOrigin({
        tenant,
        requestedOrigin: "https://studio-olivka.shario.io",
      }),
    ).toBe("https://studio-olivka.shario.io");
    expect(
      resolveCustomerSocialReturnOrigin({
        tenant,
        requestedOrigin: "https://olivka.example",
      }),
    ).toBe("https://olivka.example");
  });

  it.each([
    "https://evil.example",
    "https://shario.io",
    "https://studio-olivka.shario.io.evil.example",
    "http://studio-olivka.shario.io",
    "https://studio-olivka.shario.io:8443",
    "https://user:password@studio-olivka.shario.io",
  ])("falls unsafe or platform-root origin %s back to the tenant", (origin) => {
    process.env.NODE_ENV = "production";

    expect(
      resolveCustomerSocialReturnOrigin({
        tenant: {
          slug: "studio-olivka",
          domains: [],
        },
        requestedOrigin: origin,
      }),
    ).toBe("https://studio-olivka.shario.io");
  });

  it("removes paths, queries, and fragments before accepting a tenant origin", () => {
    process.env.NODE_ENV = "production";

    expect(
      resolveCustomerSocialReturnOrigin({
        tenant: {
          slug: "studio-olivka",
          domains: [
            {
              hostname: "olivka.example",
              status: "active",
            },
          ],
        },
        requestedOrigin:
          "https://olivka.example/login/callback?token=secret#fragment",
      }),
    ).toBe("https://olivka.example");
  });

  it("never returns a platform root even if it appears in tenant domain data", () => {
    process.env.NODE_ENV = "production";

    expect(
      resolveCustomerSocialReturnOrigin({
        tenant: {
          slug: "studio-olivka",
          domains: [
            {
              hostname: "shario.io",
              status: "active",
            },
          ],
        },
        requestedOrigin: "https://shario.io",
      }),
    ).toBe("https://studio-olivka.shario.io");
  });
});
