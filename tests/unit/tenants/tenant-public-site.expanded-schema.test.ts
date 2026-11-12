import mongoose, { Schema } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import { tenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.schema.js";

const MODEL_NAME = "TenantPublicSiteExpandedSchemaTest";
const PublicSiteFixtureModel =
  mongoose.models[MODEL_NAME] ??
  mongoose.model(
    MODEL_NAME,
    new Schema({
      publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
    }),
  );

describe("expanded tenant public-site persistence schema", () => {
  afterAll(() => {
    mongoose.deleteModel(MODEL_NAME);
  });

  it("materializes safe backwards-compatible defaults for every new surface", async () => {
    const document = new PublicSiteFixtureModel({});

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.publicSite.branding).toMatchObject({
      fontPreset: "shario-sans-v1",
      buttonTextColor: "",
      labelColor: "#1F36D4",
    });
    expect(document.publicSite.login).toMatchObject({
      eyebrow: {
        en: "",
        cs: "",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
      labelColor: "",
    });
    expect(document.publicSite.register).toMatchObject({
      eyebrow: { cs: "", en: "" },
      headline: { cs: "", en: "" },
      supportingText: { cs: "", en: "" },
      helpText: { cs: "", en: "" },
      backgroundImageUrl: "",
      labelColor: "",
    });
    expect(document.publicSite.pages.home.labelColor).toBe("");
    expect(document.publicSite.customerPortal.appearance).toMatchObject({
      headerBackgroundColor: "",
      primaryButtonColor: "",
      calendarBackgroundColor: "",
      profileMenuBackgroundColor: "",
    });
    expect(document.publicSite.customerPortal.dashboard).toMatchObject({
      eyebrow: { cs: "", en: "" },
      headline: { cs: "", en: "" },
      description: { cs: "", en: "" },
      labelColor: "",
    });
  });

  it("uppercases stored colours and rejects unknown fonts or malformed overrides", async () => {
    const valid = new PublicSiteFixtureModel({
      publicSite: {
        branding: {
          fontPreset: "warm-serif-v1",
          buttonTextColor: "#fefefe",
          labelColor: "#d27357",
        },
        login: { labelColor: "#123abc" },
        register: { labelColor: "" },
        pages: { home: { labelColor: "#abcdef" } },
        customerPortal: {
          appearance: {
            headerBackgroundColor: "#f4efe8",
            primaryButtonColor: "",
            calendarBackgroundColor: "#fffaf5",
            profileMenuBackgroundColor: "#123abc",
          },
        },
      },
    });
    await expect(valid.validate()).resolves.toBeUndefined();
    expect(valid.publicSite.branding.labelColor).toBe("#D27357");
    expect(valid.publicSite.branding.buttonTextColor).toBe("#FEFEFE");
    expect(valid.publicSite.login.labelColor).toBe("#123ABC");
    expect(valid.publicSite.pages.home.labelColor).toBe("#ABCDEF");
    expect(valid.publicSite.customerPortal.appearance).toMatchObject({
      headerBackgroundColor: "#F4EFE8",
      primaryButtonColor: "",
      calendarBackgroundColor: "#FFFAF5",
      profileMenuBackgroundColor: "#123ABC",
    });

    const invalidFont = new PublicSiteFixtureModel({
      publicSite: { branding: { fontPreset: "remote-font" } },
    });
    await expect(invalidFont.validate()).rejects.toThrow();

    const invalidColour = new PublicSiteFixtureModel({
      publicSite: {
        customerPortal: {
          appearance: { calendarBackgroundColor: "rgba(0,0,0,.5)" },
        },
      },
    });
    await expect(invalidColour.validate()).rejects.toThrow();

    const invalidButtonTextColour = new PublicSiteFixtureModel({
      publicSite: {
        branding: { buttonTextColor: "transparent" },
      },
    });
    await expect(invalidButtonTextColour.validate()).rejects.toThrow();
  });

  it("persists every rollout locale while keeping unknown fields out", async () => {
    const document = new PublicSiteFixtureModel({
      publicSite: {
        branding: {
          description: {
            en: "English",
            cs: "Čeština",
            de: "Deutsch",
            pl: "Polski",
            sk: "Slovenčina",
            da: "Dansk",
            fr: "Français",
            es: "Español",
            it: "Italiano",
            "pt-PT": "Português",
            sv: "Svenska",
            nb: "Norsk bokmål",
            fi: "Suomi",
            hu: "Magyar",
            el: "Ελληνικά",
            tr: "Türkçe",
            nl: "Nederlands",
            ro: "Română",
            ja: "Not enabled",
          },
        },
      },
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.publicSite.branding.description).toMatchObject({
      en: "English",
      cs: "Čeština",
      de: "Deutsch",
      pl: "Polski",
      sk: "Slovenčina",
      da: "Dansk",
      fr: "Français",
      es: "Español",
      it: "Italiano",
      "pt-PT": "Português",
      sv: "Svenska",
      nb: "Norsk bokmål",
      fi: "Suomi",
      hu: "Magyar",
      el: "Ελληνικά",
      tr: "Türkçe",
      nl: "Nederlands",
      ro: "Română",
    });
    expect(
      (document.publicSite.branding.description as unknown as Record<
        string,
        string
      >).ja,
    ).toBeUndefined();
  });
});
