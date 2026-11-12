import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import {
  tenantPublicSiteEditorSchema,
  tenantPublicSiteSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";

const MODEL_NAME = "TenantPublicSiteLogoRedirectTest";
const FixtureModel = mongoose.model(
  MODEL_NAME,
  new Schema({
    publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
    publicSiteEditor: {
      type: tenantPublicSiteEditorSchema,
      default: undefined,
    },
  }),
);

const brandingFor = (branding?: Record<string, unknown>) =>
  serializeTenantPublicSite({ name: "Atelier Klei", publicSite: { branding } })
    .branding;

describe("tenant-controlled logo redirect", () => {
  afterAll(() => mongoose.deleteModel(MODEL_NAME));

  it("defaults new and legacy tenants to a logo without navigation", async () => {
    const document = new FixtureModel({});
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.publicSite.branding).toMatchObject({
      logoRedirectEnabled: false,
      logoRedirectUrl: "",
    });
    expect(brandingFor()).toMatchObject({
      logoRedirectEnabled: false,
      logoRedirectUrl: "",
    });
  });

  it.each(["https://www.atelierklei.cz/", "/cs/courses?location=vaclavska"])(
    "accepts and preserves a safe destination: %s",
    async (logoRedirectUrl) => {
      const branding = { logoRedirectEnabled: true, logoRedirectUrl };
      expect(updateTenantPublicSiteSchema.parse({ branding }).branding).toEqual(
        branding,
      );
      expect(brandingFor(branding)).toMatchObject(branding);
      const document = new FixtureModel({ publicSite: { branding } });
      await expect(document.validate()).resolves.toBeUndefined();
      expect(document.publicSite.branding).toMatchObject(branding);
    },
  );

  it.each([false, true])(
    "keeps the configured destination when enabled=%s",
    (logoRedirectEnabled) => {
      const branding = {
        logoRedirectEnabled,
        logoRedirectUrl: "https://www.atelierklei.cz/",
      };
      expect(updateTenantPublicSiteSchema.parse({ branding }).branding).toEqual(
        branding,
      );
      expect(brandingFor(branding)).toMatchObject(branding);
    },
  );

  it("accepts clearing the URL when disabled but rejects an empty enabled destination", async () => {
    expect(
      updateTenantPublicSiteSchema.safeParse({
        branding: { logoRedirectEnabled: false, logoRedirectUrl: "" },
      }).success,
    ).toBe(true);
    expect(
      updateTenantPublicSiteSchema.safeParse({
        branding: { logoRedirectEnabled: true, logoRedirectUrl: "  " },
      }).success,
    ).toBe(false);
    const document = new FixtureModel({
      publicSite: { branding: { logoRedirectEnabled: true } },
    });
    await expect(document.validate()).rejects.toThrow();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "//outside.example/path",
    "/\\outside.example",
    "http://www.atelierklei.cz/",
    "https://user:pass@example.com/",
    "https://example.com:8080/",
    "atelierklei.cz",
    "mailto:studio@example.com",
  ])(
    "rejects unsafe destinations and fails closed when reading legacy data: %s",
    async (logoRedirectUrl) => {
      for (const logoRedirectEnabled of [false, true]) {
        const branding = { logoRedirectEnabled, logoRedirectUrl };
        expect(
          updateTenantPublicSiteSchema.safeParse({ branding }).success,
        ).toBe(false);
        const document = new FixtureModel({ publicSite: { branding } });
        await expect(document.validate()).rejects.toThrow();
        expect(brandingFor(branding)).toMatchObject({
          logoRedirectEnabled: false,
          logoRedirectUrl: "",
        });
      }
    },
  );

  it("requires an explicit boolean opt-in", () => {
    expect(
      brandingFor({ logoRedirectUrl: "https://www.atelierklei.cz/" })
        .logoRedirectEnabled,
    ).toBe(false);
    expect(
      brandingFor({
        logoRedirectEnabled: "true",
        logoRedirectUrl: "https://www.atelierklei.cz/",
      }).logoRedirectEnabled,
    ).toBe(false);
    expect(
      updateTenantPublicSiteSchema.safeParse({
        branding: {
          logoRedirectEnabled: "true",
          logoRedirectUrl: "https://www.atelierklei.cz/",
        },
      }).success,
    ).toBe(false);
  });

  it("persists independent draft and published settings, including publication history", async () => {
    const draft = {
      logoRedirectEnabled: true,
      logoRedirectUrl: "https://www.atelierklei.cz/",
    };
    const published = { logoRedirectEnabled: false, logoRedirectUrl: "/cs" };
    const document = new FixtureModel({
      publicSiteEditor: {
        draft: { branding: draft },
        published: { branding: published },
      },
    });
    await expect(document.validate()).resolves.toBeUndefined();
    const source = { name: "Atelier Klei", ...document.toObject() };
    expect(
      serializeTenantPublicSite(source, { snapshot: "draft" }).branding,
    ).toMatchObject(draft);
    expect(serializeTenantPublicSite(source).branding).toMatchObject(published);

    const version = new TenantPublicSiteVersionModel({
      tenant: new Types.ObjectId(),
      sourceDraftRevision: 1,
      snapshot: { branding: draft },
      publishedAt: new Date(),
    });
    await expect(version.validate()).resolves.toBeUndefined();
    expect(version.snapshot.branding).toMatchObject(draft);
  });
});
