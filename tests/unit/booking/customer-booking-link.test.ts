import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCustomerBookingLink } from "@/modules/booking/customer-booking-link.service.js";

const previousRootDomain = process.env.DEVELOPMENT_ROOT_DOMAIN;

beforeEach(() => vi.stubEnv("CLIENT_URL", "http://shario.localhost:4310"));

afterEach(() => {
  vi.unstubAllEnvs();
  if (previousRootDomain === undefined) {
    delete process.env.DEVELOPMENT_ROOT_DOMAIN;
  } else {
    process.env.DEVELOPMENT_ROOT_DOMAIN = previousRootDomain;
  }
});

describe("customer booking management links", () => {
  it.each([
    ["EN", "en"],
    ["CZ", "cs"],
  ])("uses the tenant subdomain and %s locale", (defaultLanguage, locale) => {
    process.env.DEVELOPMENT_ROOT_DOMAIN = "shario.localhost";

    const result = buildCustomerBookingLink({
      slug: "studio-olivka",
      domains: [
        {
          hostname: "customer-controlled.example",
          status: "pending",
        },
      ],
      settings: { defaultLanguage },
    });
    const url = new URL(result.url);

    expect(result.locale).toBe(locale);
    expect(url.origin).toBe("http://studio-olivka.shario.localhost:4310");
    expect(url.pathname).toBe(`/${locale}/portal`);
    expect([...url.searchParams.entries()]).toEqual([["tab", "my-bookings"]]);
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
  });

  it.each([
    "de",
    "pl",
    "sk",
    "da",
    "fr",
    "es",
    "it",
    "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "prefers the tenant's %s public primary language over the legacy field",
    (publicDefaultLanguage) => {
      process.env.DEVELOPMENT_ROOT_DOMAIN = "shario.localhost";

      const result = buildCustomerBookingLink({
        slug: "studio-olivka",
        settings: {
          defaultLanguage: "EN",
          publicDefaultLanguage,
        },
      });
      const url = new URL(result.url);

      expect(result.locale).toBe(publicDefaultLanguage);
      expect(url.pathname).toBe(`/${publicDefaultLanguage}/portal`);
      expect([...url.searchParams.entries()]).toEqual([
        ["tab", "my-bookings"],
      ]);
    },
  );

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
    "canonicalizes the tenant public locale alias %s to %s",
    (publicDefaultLanguage, expectedLocale) => {
      process.env.DEVELOPMENT_ROOT_DOMAIN = "shario.localhost";

      const result = buildCustomerBookingLink({
        slug: "studio-olivka",
        settings: {
          defaultLanguage: "EN",
          publicDefaultLanguage,
        },
      });

      expect(result.locale).toBe(expectedLocale);
      expect(new URL(result.url).pathname).toBe(`/${expectedLocale}/portal`);
    },
  );

  it.each(["ja-JP", "nn-NO"] as const)(
    "keeps unsupported public locale %s on the safe English route",
    (publicDefaultLanguage) => {
      const result = buildCustomerBookingLink({
        slug: "studio-olivka",
        settings: {
          defaultLanguage: "EN",
          publicDefaultLanguage,
        },
      });

      expect(result.locale).toBe("en");
      expect(new URL(result.url).pathname).toBe("/en/portal");
    },
  );
});

