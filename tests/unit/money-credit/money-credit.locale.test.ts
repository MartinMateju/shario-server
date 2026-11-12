import { describe, expect, it } from "vitest";

import { purchaseCreditsSchema } from "@/modules/money-credit/money-credit.validators.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

describe("money-credit checkout locale", () => {
  it.each(ROLLOUT_ELIGIBLE_APP_LOCALES)(
    "accepts the %s rollout locale",
    (locale) => {
      expect(purchaseCreditsSchema.parse({ amount: 500, locale }).locale).toBe(
        locale,
      );
    },
  );

  it.each([
    ["fr-FR", "fr"],
    ["es_MX", "es"],
    ["it-CH", "it"],
    ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const)(
    "canonicalizes the Wave 2 credit-purchase locale alias %s to %s",
    (locale, expected) => {
      expect(
        purchaseCreditsSchema.parse({
          amount: 500,
          locale,
        }).locale,
      ).toBe(expected);
    },
  );

  it.each(["ja", "nn-NO", "pt-BR"])(
    "rejects ineligible locale %s",
    (locale) => {
      expect(
        purchaseCreditsSchema.safeParse({
          amount: 500,
          locale,
        }).success,
      ).toBe(false);
    },
  );
});
