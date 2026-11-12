import { describe, expect, it } from "vitest";

import { requestPasswordResetSchema } from "@/modules/password_reset/password-reset.validators.js";

const request = (locale: string) => ({
  tenantSlug: "studio-olivka",
  email: "customer@example.com",
  locale,
});

describe("password reset locale contract", () => {
  it.each(["cs", "CZ", "cs-CZ"])(
    "keeps authored Czech copy for %s",
    (locale) => {
      expect(requestPasswordResetSchema.parse(request(locale)).locale).toBe(
        "cs",
      );
    },
  );

  it.each([
    "en-US",
    "de-DE",
    "pl-PL",
    "sk-SK",
    "da-DK",
    "fr-FR",
    "es-ES",
    "it-IT",
    "pt_PT",
    "sv-SE",
    "nb-NO",
    "no-NO",
    "fi-FI",
    "hu-HU",
    "el-GR",
    "tr-TR",
    "nl-NL",
    "nl_NL",
    "ro-RO",
    "ro_RO",
  ])("uses authored English copy fallback for rollout locale %s", (locale) => {
    expect(requestPasswordResetSchema.parse(request(locale)).locale).toBe(
      "en",
    );
  });

  it.each(["ja-JP", "nn-NO", "pt-BR", "english"])(
    "rejects the non-rollout locale %s",
    (locale) => {
      expect(requestPasswordResetSchema.safeParse(request(locale)).success).toBe(
        false,
      );
    },
  );
});

