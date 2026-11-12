import { describe, expect, it } from "vitest";

import {
  TENANT_BILLING_EMAIL_LOCALE,
  TENANT_BILLING_EMAIL_TYPE,
} from "@/modules/tenant-subscription/tenant-subscription.email.constants.js";
import { buildTenantBillingEmail } from "@/modules/tenant-subscription/tenant-subscription.email.templates.js";

const payload = {
  recipientName: "Studio Owner",
  tenantName: "Wave Studio",
  billingUrl: "https://wave-studio.shario.io/de/app/settings/billing",
  timezone: "Europe/Prague",
  trialEndsAt: "2026-09-01T12:00:00.000Z",
};

describe("tenant billing email locale contract", () => {
  it("persists every rollout-eligible route locale", () => {
    expect(Object.values(TENANT_BILLING_EMAIL_LOCALE)).toEqual([
      "en",
      "cs",
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
    ]);
  });

  it.each(["de", "pl", "sk", "da", "fr", "es", "it", "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "keeps the %s route while using explicit English copy fallback",
    (locale) => {
      const billingUrl = payload.billingUrl.replace("/de/", `/${locale}/`);
      const content = buildTenantBillingEmail({
        type: TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING,
        locale,
        payload: { ...payload, billingUrl },
      });

      expect(content.subject).toBe("Your Wave Studio trial ends soon");
      expect(content.html).toContain('<html lang="en">');
      expect(content.html).toContain(`href="${billingUrl}"`);
      expect(content.text).toContain(billingUrl);
    },
  );

  it("continues to use authored Czech copy for Czech tenants", () => {
    const content = buildTenantBillingEmail({
      type: TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING,
      locale: "cs",
      payload: {
        ...payload,
        billingUrl: payload.billingUrl.replace("/de/", "/cs/"),
      },
    });

    expect(content.subject).toContain("Zkušební období");
    expect(content.html).toContain('<html lang="cs">');
  });
});
