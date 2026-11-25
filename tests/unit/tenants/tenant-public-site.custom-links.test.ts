import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import { tenantPublicSiteEditorSchema, tenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const MODEL_NAME = "TenantPublicSiteCustomLinksTest";
const FixtureModel = mongoose.model(MODEL_NAME, new Schema({
  name: String,
  publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
  publicSiteEditor: { type: tenantPublicSiteEditorSchema, default: undefined },
}));
const link = (id = "studio") => ({
  id,
  label: { cs: "Naše studio", en: "Our studio" },
  href: { cs: "https://studio.example/cs/studio/", en: "https://studio.example/en/studio/" },
});

describe("public-site custom links", () => {
  afterAll(() => mongoose.deleteModel(MODEL_NAME));

  it.each(["header", "footer"])("accepts localized HTTPS and root-relative %s links and explicit clearing", (section) => {
    const entry = { ...link(), href: { cs: "/cs/courses?location=main", en: "/en/courses#schedule" } };
    expect(updateTenantPublicSiteSchema.parse({ [section]: { customLinks: [entry] } })).toEqual({ [section]: { customLinks: [entry] } });
    expect(updateTenantPublicSiteSchema.parse({ [section]: { customLinks: [] } })).toEqual({ [section]: { customLinks: [] } });
    const fallback = { id: "fallback", label: { en: "Studio", cs: "" }, href: { en: "https://studio.example/", cs: "" } };
    expect(updateTenantPublicSiteSchema.safeParse({ [section]: { customLinks: [fallback] } }).success).toBe(true);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,<svg>", "http://studio.example/", "//evil.example/",
    "/\\evil.example/", "https://studio.example\\@evil.example/", "https://user:pass@studio.example/",
    "https://studio.example:444/", "https://studio.example/\npath", "/cs/\u0000test",
  ])("rejects unsafe custom link destination %s on write and serialization", (href) => {
    const unsafe = { ...link(), href: { cs: href, en: "https://studio.example/en/" } };
    expect(updateTenantPublicSiteSchema.safeParse({ header: { customLinks: [unsafe] } }).success).toBe(false);
    expect(serializeTenantPublicSite({ name: "Studio", publicSite: { header: { customLinks: [unsafe] } } }).header.customLinks).toEqual([]);
  });

  it("rejects duplicate ids, invalid ids, incomplete translations, markup, overlong values and excessive lists", () => {
    for (const customLinks of [
      [link(), link()], [{ ...link(), id: "bad id" }], [{ ...link(), id: "_bad" }],
      [{ ...link(), label: { cs: "", en: "" } }],
      [{ ...link(), href: { cs: "", en: "https://studio.example/" } }],
      [{ ...link(), label: { cs: "x".repeat(81), en: "Studio" } }],
      [{ ...link(), label: { cs: "<script>alert(1)</script>", en: "Studio" } }],
      [{ ...link(), href: { cs: `https://studio.example/${"a".repeat(2048)}`, en: "" } }],
    ]) expect(updateTenantPublicSiteSchema.safeParse({ header: { customLinks } }).success).toBe(false);
    const entries = Array.from({ length: 13 }, (_, i) => link(`link-${i}`));
    expect(updateTenantPublicSiteSchema.safeParse({ header: { customLinks: entries.slice(0, 8) } }).success).toBe(true);
    expect(updateTenantPublicSiteSchema.safeParse({ header: { customLinks: entries.slice(0, 9) } }).success).toBe(false);
    expect(updateTenantPublicSiteSchema.safeParse({ footer: { customLinks: entries.slice(0, 12) } }).success).toBe(true);
    expect(updateTenantPublicSiteSchema.safeParse({ footer: { customLinks: entries } }).success).toBe(false);
  });

  it("keeps legacy defaults empty and filters invalid persisted entries without changing valid order", async () => {
    const legacy = new FixtureModel({ name: "Studio" });
    await expect(legacy.validate()).resolves.toBeUndefined();
    expect(legacy.publicSite.header.customLinks).toHaveLength(0);
    expect(legacy.publicSite.footer.customLinks).toHaveLength(0);
    const config = serializeTenantPublicSite({ name: "Studio", publicSite: { header: {
      customLinks: [link("second"), link("first"), link("second"), { ...link("invalid"), id: "bad id" }],
    } } });
    expect(config.header.customLinks.map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(config.footer.customLinks).toEqual([]);
  });

  it("preserves links in live data, separate draft/published snapshots, hydration and publication history", async () => {
    const published = { header: { customLinks: [link("published")] }, footer: { customLinks: [link("footer")] } };
    const draft = { header: { customLinks: [link("draft")] }, footer: { customLinks: [] } };
    const document = new FixtureModel({ name: "Studio", publicSite: published, publicSiteEditor: { draft, published } });
    await expect(document.validate()).resolves.toBeUndefined();
    const hydrated = FixtureModel.hydrate(document.toObject());
    const source = { name: "Studio", publicSite: hydrated.publicSite, publicSiteEditor: hydrated.publicSiteEditor };
    expect(serializeTenantPublicSite(source).header.customLinks).toMatchObject([link("published")]);
    expect(serializeTenantPublicSite(source).footer.customLinks).toMatchObject([link("footer")]);
    expect(serializeTenantPublicSite(source, { snapshot: "draft" }).header.customLinks).toMatchObject([link("draft")]);
    expect(serializeTenantPublicSite(source, { snapshot: "draft" }).footer.customLinks).toEqual([]);
    const version = new TenantPublicSiteVersionModel({ tenant: new Types.ObjectId(), sourceDraftRevision: 3, snapshot: draft, publishedAt: new Date() });
    await expect(version.validate()).resolves.toBeUndefined();
    expect(version.snapshot.header.customLinks.map((entry: { id: string }) => entry.id)).toEqual(["draft"]);
    expect(version.snapshot.footer.customLinks).toHaveLength(0);
  });

  it("rejects unsafe and duplicate links in database schema validation too", async () => {
    for (const customLinks of [[link(), link()], [{ ...link(), href: { en: "javascript:alert(1)", cs: "" } }]]) {
      const document = new FixtureModel({ name: "Studio", publicSite: { header: { customLinks } } });
      await expect(document.validate()).rejects.toThrow();
    }
  });
});
