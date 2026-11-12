import { describe, expect, it } from "vitest";

import { TENANT_PAYMENT_CONNECT_LOCALE } from "@/modules/tenant-payments/tenant-payment-account.constants.js";
import {
  tenantPaymentConnectOnboardingSchema,
  validateTenantPaymentInput,
} from "@/modules/tenant-payments/tenant-payment.validators.js";

describe("tenant payment Connect validation", () => {
  it("defaults the hosted onboarding locale to English", () => {
    expect(
      validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {}),
    ).toEqual({ locale: "en" });
  });

  it("keeps the Connect locale constants aligned with the rollout contract", () => {
    expect(Object.values(TENANT_PAYMENT_CONNECT_LOCALE)).toEqual([
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

  it.each([
    ["en-US", "en"],
    ["cs-CZ", "cs"],
    ["de-DE", "de"],
    ["pl-PL", "pl"],
    ["sk-SK", "sk"],
    ["da-DK", "da"],
    ["fr-FR", "fr"],
    ["es-ES", "es"],
    ["it-IT", "it"],
    ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const)("canonicalizes Connect locale %s to %s", (input, expected) => {
    expect(
      validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {
        locale: input,
      }),
    ).toEqual({ locale: expected });
  });

  it("accepts an allowlisted setup marker", () => {
    expect(
      validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {
        locale: "en",
        setupStep: "payments",
      }),
    ).toEqual({ locale: "en", setupStep: "payments" });

    expect(() =>
      validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {
        locale: "en",
        setupStep: "studio",
      }),
    ).toThrow("Invalid request body");

    expect(() =>
      validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {
        locale: "en",
        returnUrl: "https://attacker.example",
      }),
    ).toThrow("Invalid request body");
  });

  it.each(["ja-JP", "nn-NO", "pt-BR", "english"])(
    "rejects non-rollout Connect locale %s",
    (locale) => {
      expect(() =>
        validateTenantPaymentInput(tenantPaymentConnectOnboardingSchema, {
          locale,
        }),
      ).toThrow("Invalid request body");
    },
  );
});
