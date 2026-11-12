import { afterEach, describe, expect, it } from "vitest";

import { getTenantPaymentConnectUrls } from "@/modules/tenant-payments/tenant-payment.urls.js";
import { tenantPaymentConnectOnboardingSchema } from "@/modules/tenant-payments/tenant-payment.validators.js";

const originalClientUrl = process.env.CLIENT_URL;

afterEach(() => {
  process.env.CLIENT_URL = originalClientUrl;
});

describe("tenant payment Connect URLs", () => {
  it("builds locale-aware localhost tenant URLs from trusted configuration", () => {
    process.env.CLIENT_URL = "http://localhost:3000";

    expect(
      getTenantPaymentConnectUrls({
        tenantSlug: "studio-grohovka",
        locale: "cs",
      }),
    ).toEqual({
      refreshUrl:
        "http://studio-grohovka.localhost:3000/cs/app/settings/payments?connect=refresh",
      returnUrl:
        "http://studio-grohovka.localhost:3000/cs/app/settings/payments?connect=return",
    });
  });

  it("builds production tenant subdomains without accepting a client URL", () => {
    process.env.CLIENT_URL = "https://shario.io";

    const urls = getTenantPaymentConnectUrls({
      tenantSlug: "studio-emilka",
      locale: "en",
    });

    expect(urls.returnUrl).toBe(
      "https://studio-emilka.shario.io/en/app/settings/payments?connect=return",
    );
  });

  it("preserves European Portuguese in Connect return routes", () => {
    process.env.CLIENT_URL = "https://shario.io";

    const urls = getTenantPaymentConnectUrls({
      tenantSlug: "studio-emilka",
      locale: "pt-PT",
    });

    expect(urls.returnUrl).toBe(
      "https://studio-emilka.shario.io/pt-PT/app/settings/payments?connect=return",
    );
  });

  it.each([
    ["sv-SE", "sv"],
    ["no_NO", "nb"],
    ["nb-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const)(
    "canonicalizes Connect locale alias %s to the %s route",
    (locale, expectedLocale) => {
      process.env.CLIENT_URL = "https://shario.io";
      const input = tenantPaymentConnectOnboardingSchema.parse({ locale });

      const urls = getTenantPaymentConnectUrls({
        tenantSlug: "studio-emilka",
        locale: input.locale,
      });

      expect(urls.refreshUrl).toContain(`/${expectedLocale}/app/`);
      expect(urls.returnUrl).toContain(`/${expectedLocale}/app/`);
    },
  );

  it.each(["ja-JP", "nn-NO"] as const)(
    "rejects unsupported Connect locale %s at the validator boundary",
    (locale) => {
      expect(
        tenantPaymentConnectOnboardingSchema.safeParse({ locale }).success,
      ).toBe(false);
    },
  );

  it("preserves the allowlisted Launch Center payment marker", () => {
    process.env.CLIENT_URL = "https://shario.io";

    expect(
      getTenantPaymentConnectUrls({
        tenantSlug: "studio-emilka",
        locale: "en",
        setupStep: "payments",
      }),
    ).toEqual({
      refreshUrl:
        "https://studio-emilka.shario.io/en/app/settings/payments?connect=refresh&setupStep=payments",
      returnUrl:
        "https://studio-emilka.shario.io/en/app/settings/payments?connect=return&setupStep=payments",
    });
  });

  it("rejects a slug that could alter the configured host", () => {
    process.env.CLIENT_URL = "https://shario.io";

    expect(() =>
      getTenantPaymentConnectUrls({
        tenantSlug: "evil.example.com",
        locale: "en",
      }),
    ).toThrow("valid tenant slug");
  });
});
