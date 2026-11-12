import { describe, expect, it } from "vitest";

import {
  checkoutSchema,
  portalSchema,
} from "@/modules/tenant-subscription/tenant-subscription.validators.js";

const checkout = (locale: string) => ({
  plan: "professional",
  billingInterval: "monthly",
  locale,
});

describe("tenant subscription locale contract", () => {
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
  ] as const)("canonicalizes %s to %s", (input, expected) => {
    expect(checkoutSchema.parse(checkout(input)).locale).toBe(expected);
    expect(portalSchema.parse({ locale: input }).locale).toBe(expected);
  });

  it.each(["ja-JP", "nn-NO", "pt-BR", "english"])(
    "rejects the non-rollout locale %s",
    (locale) => {
      expect(checkoutSchema.safeParse(checkout(locale)).success).toBe(false);
      expect(portalSchema.safeParse({ locale }).success).toBe(false);
    },
  );
});
