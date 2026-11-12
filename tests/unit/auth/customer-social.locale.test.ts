import { describe, expect, it } from "vitest";

import { customerSocialStartQuerySchema } from "@/modules/auth/social/customer-social.validators.js";

const query = (locale?: string) => ({
  tenantSlug: "studio-olivka",
  ...(locale === undefined ? {} : { locale }),
});

describe("customer social locale contract", () => {
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
    ["gr_GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ] as const)("canonicalizes %s to %s", (input, expected) => {
    expect(customerSocialStartQuerySchema.parse(query(input)).locale).toBe(
      expected,
    );
  });

  it("defaults to English", () => {
    expect(customerSocialStartQuerySchema.parse(query()).locale).toBe("en");
  });

  it.each(["ja-JP", "nn-NO", "pt-BR", "english"])(
    "rejects the non-rollout locale %s",
    (locale) => {
      expect(
        customerSocialStartQuerySchema.safeParse(query(locale)).success,
      ).toBe(false);
    },
  );
});
