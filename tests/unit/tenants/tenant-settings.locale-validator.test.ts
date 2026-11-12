import { describe, expect, it } from "vitest";

import { updateTenantSettingsSchema } from "@/modules/tenants/settings/tenant-settings.validators.js";

describe("tenant locale settings validation", () => {
  it("accepts and canonicalizes the rollout locale contract", () => {
    expect(
      updateTenantSettingsSchema.parse({
        defaultLanguage: "CZ",
        adminLanguage: "de-DE",
        publicDefaultLanguage: "pl-PL",
        supportedPublicLanguages: ["EN", "pl", "pl-PL"],
      }),
    ).toEqual({
      defaultLanguage: "cs",
      adminLanguage: "de",
      publicDefaultLanguage: "pl",
      supportedPublicLanguages: ["en", "pl"],
    });
  });

  it("accepts canonical Wave 2A workspace and public locale aliases", () => {
    expect(
      updateTenantSettingsSchema.parse({
        adminLanguage: "fr-FR",
        publicDefaultLanguage: "pt_PT",
        supportedPublicLanguages: ["pt-PT", "it-IT"],
      }),
    ).toEqual({
      adminLanguage: "fr",
      publicDefaultLanguage: "pt-PT",
      supportedPublicLanguages: ["pt-PT", "it"],
    });
  });

  it("accepts canonical Wave 2B workspace and public locale aliases", () => {
    expect(
      updateTenantSettingsSchema.parse({
        adminLanguage: "sv-SE",
        publicDefaultLanguage: "no-NO",
        supportedPublicLanguages: ["nb", "fi-FI"],
      }),
    ).toEqual({
      adminLanguage: "sv",
      publicDefaultLanguage: "nb",
      supportedPublicLanguages: ["nb", "fi"],
    });
  });

  it("accepts canonical Wave 2C workspace and public locale aliases", () => {
    expect(
      updateTenantSettingsSchema.parse({
        adminLanguage: "hu-HU",
        publicDefaultLanguage: "el-GR",
        supportedPublicLanguages: ["el", "tr-TR"],
      }),
    ).toEqual({
      adminLanguage: "hu",
      publicDefaultLanguage: "el",
      supportedPublicLanguages: ["el", "tr"],
    });
  });

  it("accepts canonical Dutch workspace and public locale aliases", () => {
    expect(
      updateTenantSettingsSchema.parse({
        adminLanguage: "nl-NL",
        publicDefaultLanguage: "nl_NL",
        supportedPublicLanguages: ["nl", "nl-NL"],
      }),
    ).toEqual({
      adminLanguage: "nl",
      publicDefaultLanguage: "nl",
      supportedPublicLanguages: ["nl"],
    });
  });

  it("accepts canonical Romanian workspace and public locale aliases", () => {
    expect(
      updateTenantSettingsSchema.parse({
        adminLanguage: "ro-RO",
        publicDefaultLanguage: "ro_RO",
        supportedPublicLanguages: ["ro", "ro-RO"],
      }),
    ).toEqual({
      adminLanguage: "ro",
      publicDefaultLanguage: "ro",
      supportedPublicLanguages: ["ro"],
    });
  });

  it("rejects more than two distinct public languages", () => {
    const result = updateTenantSettingsSchema.safeParse({
      publicDefaultLanguage: "en",
      supportedPublicLanguages: ["en", "de-DE", "pl-PL"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "primary language and one optional secondary language",
      );
    }
  });

  it("applies the limit after aliases are canonicalized and de-duplicated", () => {
    expect(
      updateTenantSettingsSchema.parse({
        supportedPublicLanguages: ["DE", "de-DE", "PL", "pl-PL"],
      }).supportedPublicLanguages,
    ).toEqual(["de", "pl"]);
  });

  it.each(["ja-JP", "nn-NO", "pt-BR"])(
    "keeps the non-rollout locale %s unavailable",
    (publicDefaultLanguage) => {
      expect(
        updateTenantSettingsSchema.safeParse({
          publicDefaultLanguage,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown locale values rather than silently using English", () => {
    expect(
      updateTenantSettingsSchema.safeParse({
        adminLanguage: "unknown",
      }).success,
    ).toBe(false);
  });
});
