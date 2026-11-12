import { describe, expect, it } from "vitest";

import { TENANT_BILLING_EMAIL_TYPE } from "@/modules/tenant-subscription/tenant-subscription.email.constants.js";
import { buildTenantBillingEmail } from "@/modules/tenant-subscription/tenant-subscription.email.templates.js";

const payload = {
  recipientName: "Martin",
  tenantName: "Studio Grohovka",
  billingUrl: "https://studio-grohovka.shario.io/en/app/settings/billing",
  timezone: "Europe/Prague",
  graceEndsAt: "2026-08-01T12:00:00.000Z",
  nextPaymentAttemptAt: "2026-07-23T12:00:00.000Z",
  attemptCount: 1,
};

describe("tenant billing email templates", () => {
  it("renders accessible HTML and plain text in English", () => {
    const email = buildTenantBillingEmail({
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED,
      locale: "en",
      payload,
    });

    expect(email.subject).toContain("Studio Grohovka");
    expect(email.text).toContain(payload.billingUrl);
    expect(email.html).toContain('lang="en"');
    expect(email.html).toContain("Open billing settings");
  });

  it("renders the Czech owner communication", () => {
    const email = buildTenantBillingEmail({
      type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_ACTION_REQUIRED,
      locale: "cs",
      payload: {
        ...payload,
        billingUrl: "https://studio-grohovka.shario.io/cs/app/settings/billing",
      },
    });

    expect(email.subject).toContain("nutné ověřit");
    expect(email.html).toContain('lang="cs"');
    expect(email.text).toContain("Otevřít nastavení fakturace");
  });

  it("escapes tenant-controlled text in HTML", () => {
    const email = buildTenantBillingEmail({
      type: TENANT_BILLING_EMAIL_TYPE.TRIAL_ENDING,
      locale: "en",
      payload: {
        ...payload,
        tenantName: '<img src=x onerror="alert(1)">',
        trialEndsAt: "2026-07-23T12:00:00.000Z",
      },
    });

    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x");
  });

  it("rejects non-web billing links", () => {
    expect(() =>
      buildTenantBillingEmail({
        type: TENANT_BILLING_EMAIL_TYPE.PAYMENT_FAILED,
        locale: "en",
        payload: { ...payload, billingUrl: "javascript:alert(1)" },
      }),
    ).toThrow("HTTP or HTTPS");
  });
});
