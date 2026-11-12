import { describe, expect, it } from "vitest";

import { registerTenantSchema } from "@/modules/auth/auth.validators.js";
import { resolveRegistrationPreferences } from "@/modules/auth/registration-preferences.js";
import TenantModel from "@/modules/tenants/tenant.model.js";

const account = {
  firstname: "Alex", lastname: "Example", email: "alex@example.test",
  password: "safe-password-123", tenantName: "International Studio", slug: "international-studio",
};

describe("new tenant regional preferences", () => {
  it.each([
    ["PL", "PLN"], ["CZ", "CZK"], ["GB", "GBP"], ["CH", "CHF"],
    ["DK", "DKK"], ["SE", "SEK"], ["NO", "NOK"], ["CA", "CAD"],
    ["AU", "AUD"], ["US", "USD"], ["DE", "EUR"], ["BG", "EUR"],
    ["JP", "USD"], ["HU", "USD"], ["RO", "USD"], [undefined, "USD"],
  ])("suggests %s's supported currency %s independently of language", (country, currency) => {
    expect(resolveRegistrationPreferences({ country, locale: "en" }).currency).toBe(currency);
  });

  it("does not infer a country from a language-only preference", () => {
    expect(resolveRegistrationPreferences({ locale: "pl" })).toEqual({
      locale: "pl", country: "", currency: "USD", timezone: "UTC",
    });
  });

  it("validates and normalizes a manual currency choice before persisting it", async () => {
    const input = registerTenantSchema.parse({
      ...account, locale: "pl", country: " pl ", currency: " eur ", timezone: "Europe/Warsaw",
    });
    const preferences = resolveRegistrationPreferences(input);
    expect(preferences).toEqual({
      locale: "pl", country: "PL", currency: "EUR", timezone: "Europe/Warsaw",
    });
    const tenant = new TenantModel({
      name: account.tenantName, slug: account.slug,
      settings: {
        currency: preferences.currency, timezone: preferences.timezone,
        adminLanguage: preferences.locale, publicDefaultLanguage: preferences.locale,
        supportedPublicLanguages: [preferences.locale],
      },
      onboarding: { businessDetails: { country: preferences.country } },
    });
    await tenant.validate();
    expect(tenant.settings.currency).toBe("EUR");
    expect(tenant.settings.adminLanguage).toBe("pl");
    expect(tenant.settings.publicDefaultLanguage).toBe("pl");
    expect(tenant.onboarding.businessDetails?.country).toBe("PL");
  });

  it.each([
    { currency: "JPY" }, { currency: "INVALID" }, { locale: "xx" },
    { country: "Poland" }, { timezone: "Mars/Olympus" }, { billingAmount: 1 },
  ])("rejects invalid or uncontrolled signup fields: %j", (preferences) => {
    expect(registerTenantSchema.safeParse({ ...account, ...preferences }).success).toBe(false);
  });
});
