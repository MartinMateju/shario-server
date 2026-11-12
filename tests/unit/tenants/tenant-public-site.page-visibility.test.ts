import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import {
  tenantPublicSiteEditorSchema,
  tenantPublicSiteSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const pages = ["book", "courses", "memberships", "vouchers", "help"] as const;
const MODEL_NAME = "TenantPublicSitePageVisibilityTest";
const FixtureModel = mongoose.model(
  MODEL_NAME,
  new Schema({
    name: String,
    publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
    publicSiteEditor: {
      type: tenantPublicSiteEditorSchema,
      default: undefined,
    },
  }),
);

describe("public page visibility", () => {
  afterAll(() => mongoose.deleteModel(MODEL_NAME));

  it.each(pages)("accepts boolean-only visibility patches for %s", (page) => {
    for (const visible of [true, false]) {
      const patch = { pages: { [page]: { visible } } };
      expect(updateTenantPublicSiteSchema.parse(patch)).toEqual(patch);
    }
    for (const visible of ["false", 0, null]) {
      expect(
        updateTenantPublicSiteSchema.safeParse({
          pages: { [page]: { visible } },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps legacy pages visible without adding visibility to homepage section copy", async () => {
    const legacy = new FixtureModel({ name: "Studio" });
    await expect(legacy.validate()).resolves.toBeUndefined();
    const config = serializeTenantPublicSite({ name: "Studio" });
    for (const page of pages) {
      expect(legacy.publicSite.pages[page].visible).toBe(true);
      expect(config.pages[page].visible).toBe(true);
    }
    expect(
      legacy.toObject().publicSite.pages.home.sectionContent.about,
    ).not.toHaveProperty("visible");
    expect(
      updateTenantPublicSiteSchema.safeParse({
        pages: { home: { sectionContent: { about: { visible: false } } } },
      }).success,
    ).toBe(false);
  });

  it.each(pages)(
    "preserves hidden %s through storage, snapshots and publication history",
    async (page) => {
      const hidden = {
        pages: { [page]: { visible: false, title: { en: "Keep my copy" } } },
      };
      const document = new FixtureModel({
        name: "Studio",
        publicSite: hidden,
        publicSiteEditor: {
          draft: { pages: { [page]: { visible: true } } },
          published: hidden,
        },
      });
      await expect(document.validate()).resolves.toBeUndefined();
      const hydrated = FixtureModel.hydrate(document.toObject());
      expect(hydrated.publicSite.pages[page].visible).toBe(false);
      const source = {
        ...hydrated.toObject(),
        name: String(hydrated.name ?? "Studio"),
      };
      expect(serializeTenantPublicSite(source).pages[page]).toMatchObject({
        visible: false,
        title: { en: "Keep my copy" },
      });
      expect(
        serializeTenantPublicSite(source, { snapshot: "draft" }).pages[page]
          .visible,
      ).toBe(true);

      const version = new TenantPublicSiteVersionModel({
        tenant: new Types.ObjectId(),
        sourceDraftRevision: 1,
        snapshot: hidden,
        publishedAt: new Date(),
      });
      await expect(version.validate()).resolves.toBeUndefined();
      expect(version.snapshot.pages[page].visible).toBe(false);
    },
  );
});
