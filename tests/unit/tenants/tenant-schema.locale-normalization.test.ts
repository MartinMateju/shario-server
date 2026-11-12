import { describe, expect, it } from "vitest";

import TenantModel from "@/modules/tenants/tenant.model.js";

const tenantWithSettings = (settings: Record<string, unknown>) =>
  new TenantModel({
    name: "Locale contract test",
    slug: "locale-contract-test",
    settings,
  });

describe("tenant schema locale normalization", () => {
  it("persists the public default after the Mongoose list setter runs", async () => {
    const tenant = tenantWithSettings({
      defaultLanguage: "EN",
      publicDefaultLanguage: "da",
      supportedPublicLanguages: ["de"],
    });

    await tenant.validate();

    expect(tenant.settings.supportedPublicLanguages).toEqual(["da", "de"]);
    expect(tenant.settings.defaultLanguage).toBe("EN");
  });

  it("rejects a third public language when the locale contract is written", async () => {
    const tenant = tenantWithSettings({
      publicDefaultLanguage: "en",
      supportedPublicLanguages: ["en", "de", "pl"],
    });

    await expect(tenant.validate()).rejects.toThrow(
      "primary language and one optional secondary language",
    );
  });

  it("does not block an unrelated save of a historical multi-language document", async () => {
    const tenant = TenantModel.hydrate({
      name: "Historical locale contract",
      slug: "historical-locale-contract",
      settings: {
        defaultLanguage: "EN",
        adminLanguage: "en",
        publicDefaultLanguage: "en",
        supportedPublicLanguages: ["en", "de", "pl"],
        currency: "EUR",
        timezone: "Europe/Prague",
      },
    });

    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(tenant.settings.supportedPublicLanguages).toEqual([
      "en",
      "de",
      "pl",
    ]);
  });

  it("canonicalizes the public default before its optional secondary", async () => {
    const tenant = tenantWithSettings({
      publicDefaultLanguage: "pl-PL",
      supportedPublicLanguages: ["DE-de", "PL-pl"],
    });

    await tenant.validate();

    expect(tenant.settings.supportedPublicLanguages).toEqual(["pl", "de"]);
  });

  it("derives canonical Czech fields without changing the legacy CZ bridge", async () => {
    const tenant = tenantWithSettings({ defaultLanguage: "CZ" });

    await tenant.validate();

    expect(tenant.settings).toMatchObject({
      defaultLanguage: "CZ",
      adminLanguage: "cs",
      publicDefaultLanguage: "cs",
      supportedPublicLanguages: ["cs"],
    });
  });

  it("uses English for new tenants with no language settings", async () => {
    const tenant = tenantWithSettings({});

    await tenant.validate();

    expect(tenant.settings).toMatchObject({
      defaultLanguage: "EN",
      adminLanguage: "en",
      publicDefaultLanguage: "en",
      supportedPublicLanguages: ["en"],
    });
  });
});
