import { describe, expect, it } from "vitest";

import {
  MAX_TENANT_PUBLIC_LANGUAGES,
  resolveTenantLocaleSettings,
  toLegacyTenantLanguage,
} from "@/modules/tenants/tenant-locale.js";

describe("tenant locale compatibility", () => {
  it("hydrates legacy tenant language values into the canonical contract", () => {
    expect(resolveTenantLocaleSettings({ defaultLanguage: "CZ" })).toEqual({
      defaultLanguage: "CZ",
      adminLanguage: "cs",
      publicDefaultLanguage: "cs",
      supportedPublicLanguages: ["cs"],
    });
  });

  it("keeps public and administrator defaults independent", () => {
    expect(
      resolveTenantLocaleSettings({
        defaultLanguage: "EN",
        adminLanguage: "de-DE",
        publicDefaultLanguage: "pl-PL",
        supportedPublicLanguages: ["EN", "de", "pl", "pl-PL"],
      }),
    ).toEqual({
      defaultLanguage: "EN",
      adminLanguage: "de",
      publicDefaultLanguage: "pl",
      supportedPublicLanguages: ["pl", "en"],
    });
  });

  it("puts the public default first and keeps one optional secondary", () => {
    expect(
      resolveTenantLocaleSettings({
        publicDefaultLanguage: "da",
        supportedPublicLanguages: ["de"],
      }).supportedPublicLanguages,
    ).toEqual(["da", "de"]);
  });

  it("limits historical public locale lists safely on reads", () => {
    const settings = resolveTenantLocaleSettings({
      publicDefaultLanguage: "de",
      supportedPublicLanguages: ["en", "cs", "de", "pl"],
    });

    expect(MAX_TENANT_PUBLIC_LANGUAGES).toBe(2);
    expect(settings.supportedPublicLanguages).toEqual(["de", "en"]);
  });

  it("uses English for a new tenant with no persisted language", () => {
    expect(resolveTenantLocaleSettings({})).toEqual({
      defaultLanguage: "EN",
      adminLanguage: "en",
      publicDefaultLanguage: "en",
      supportedPublicLanguages: ["en"],
    });
  });

  it("keeps the persisted compatibility bridge safe for untouched consumers", () => {
    const legacyConsumer = (value: string) =>
      value === "EN" ? "en" : "cs";

    expect(toLegacyTenantLanguage("CZ")).toBe("CZ");
    expect(toLegacyTenantLanguage("cs-CZ")).toBe("CZ");
    expect(toLegacyTenantLanguage("EN")).toBe("EN");
    expect(toLegacyTenantLanguage("de-DE")).toBe("EN");
    expect(legacyConsumer(toLegacyTenantLanguage("cs")!)).toBe("cs");
    expect(legacyConsumer(toLegacyTenantLanguage("pl")!)).toBe("en");
    expect(
      resolveTenantLocaleSettings({ defaultLanguage: "CZ" })
        .publicDefaultLanguage,
    ).toBe("cs");
    expect(
      resolveTenantLocaleSettings({ defaultLanguage: "EN" })
        .publicDefaultLanguage,
    ).toBe("en");
  });
});
