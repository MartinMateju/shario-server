import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import { tenantPublicSiteEditorSchema, tenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const MODEL_NAME = "TenantPublicSiteGroupedHeaderTest";
const FixtureModel = mongoose.model(MODEL_NAME, new Schema({
  name: String,
  publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
  publicSiteEditor: { type: tenantPublicSiteEditorSchema, default: undefined },
}));
const leaf = (id = "classes") => ({
  id, label: { cs: "Kurzy", en: "Classes" }, href: { cs: "/cs/courses", en: "/en/courses" },
});
const group = (id = "learn") => ({ id, label: { cs: "Tvořit", en: "Create" }, children: [leaf()] });
const parseHeader = (header: unknown) => updateTenantPublicSiteSchema.safeParse({ header });

describe("grouped public header", () => {
  afterAll(() => mongoose.deleteModel(MODEL_NAME));

  it("accepts one-level localized groups, independently scoped ids, separators, one CTA, and optional colours", () => {
    const header = {
      layout: "website", backgroundColor: "#f6eade", linkColor: "#2f61cc", buttonColor: "",
      customLinks: [
        { ...group(), label: { cs: "Tvořit", en: "" }, children: [
          leaf(), { id: "studio", label: { cs: "", en: "Studio" }, href: { cs: "", en: "https://studio.example/en/" }, separatorBefore: true },
        ] },
        group("discover"),
        { ...leaf("book"), emphasis: "button" },
      ],
    };
    const result = parseHeader(header);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.header).toEqual({ ...header, backgroundColor: "#F6EADE", linkColor: "#2F61CC" });
    expect(parseHeader({ customLinks: [] }).success).toBe(true);
    expect(parseHeader({ layout: "default", backgroundColor: "", linkColor: "", buttonColor: "#ed8467" }).success).toBe(true);
  });

  it("rejects invalid shapes, nesting, duplicate ids, incomplete child translations and extra buttons", async () => {
    const invalidLists = [
      [{ ...group(), children: [] }],
      [{ ...group(), label: { cs: "", en: "" } }],
      [{ ...group(), label: { cs: "x".repeat(81) } }],
      [{ ...group(), label: { cs: "<b>Menu</b>" } }],
      [{ ...group(), children: Array.from({ length: 9 }, (_, i) => leaf(`child-${i}`)) }],
      [{ ...group(), children: [leaf(), leaf()] }],
      [group(), group()],
      [{ ...group(), href: leaf().href }],
      [{ ...group(), emphasis: "button" }],
      [{ ...group(), children: [group("nested")] }],
      [{ ...group(), children: [{ ...leaf(), children: [leaf("nested")] }] }],
      [{ ...group(), children: [{ ...leaf(), emphasis: "button" }] }],
      [{ ...group(), children: [{ ...leaf(), href: { cs: "", en: "/en/courses" } }] }],
      [{ ...leaf("first"), emphasis: "button" }, { ...leaf("second"), emphasis: "button" }],
      [{ ...leaf(), emphasis: "plain" }],
      [{ ...leaf(), separatorBefore: true }],
    ];
    for (const customLinks of invalidLists) {
      expect(parseHeader({ customLinks }).success).toBe(false);
      await expect(new FixtureModel({ publicSite: { header: { customLinks } } }).validate()).rejects.toThrow();
    }
    for (const header of [{ layout: "unknown" }, { backgroundColor: "red" }, { linkColor: "#abc" }, { buttonColor: "url(https://example.test)" }]) {
      expect(parseHeader(header).success).toBe(false);
    }
    expect(parseHeader({ customLinks: [{ ...group(), children: [{ ...leaf(), separatorBefore: "yes" }] }] }).success).toBe(false);
    for (const customLinks of [[group()], [{ ...leaf(), emphasis: "button" }], [{ ...leaf(), separatorBefore: true }]]) {
      expect(updateTenantPublicSiteSchema.safeParse({ footer: { customLinks } }).success).toBe(false);
    }
  });

  it.each(["javascript:alert(1)", "//evil.example", "/\\evil.example", "https://user:pass@example.test/", "/cs/\ncourse"])(
    "rejects unsafe child URL %s in validation, database and public serialization", async (href) => {
      const customLinks = [{ ...group(), children: [{ ...leaf(), href: { cs: href, en: "/en/courses" } }] }];
      expect(parseHeader({ customLinks }).success).toBe(false);
      await expect(new FixtureModel({ publicSite: { header: { customLinks } } }).validate()).rejects.toThrow();
      expect(serializeTenantPublicSite({ name: "Studio", publicSite: { header: { customLinks } } }).header.customLinks).toEqual([]);
    },
  );

  it("preserves groups and colours through mongoose hydration, published/draft serialization and history", async () => {
    const draft = { header: {
      layout: "website", backgroundColor: "#f6eade", linkColor: "#2f61cc", buttonColor: "#ed8467",
      customLinks: [{ ...group(), children: [leaf(), { ...leaf("studio"), separatorBefore: true }] }, { ...leaf("book"), emphasis: "button" }],
    } };
    const published = { header: { customLinks: [leaf("old")] } };
    const document = new FixtureModel({ name: "Studio", publicSite: published, publicSiteEditor: { draft, published } });
    await expect(document.validate()).resolves.toBeUndefined();
    const hydrated = FixtureModel.hydrate(document.toObject());
    const source = { name: "Studio", publicSite: hydrated.publicSite, publicSiteEditor: hydrated.publicSiteEditor };
    const saved = serializeTenantPublicSite(source, { snapshot: "draft" });
    expect(saved.header).toMatchObject({ ...draft.header, backgroundColor: "#F6EADE", linkColor: "#2F61CC", buttonColor: "#ED8467" });
    expect(saved.header.customLinks[0]?.children?.[0]?.separatorBefore).toBe(false);
    expect(saved.header.customLinks[0]).not.toHaveProperty("href");
    expect(saved.header.customLinks[1]).not.toHaveProperty("children");
    expect(serializeTenantPublicSite(source).header).toMatchObject({ layout: "default", backgroundColor: "", linkColor: "", buttonColor: "", customLinks: [leaf("old")] });
    const version = new TenantPublicSiteVersionModel({ tenant: new Types.ObjectId(), sourceDraftRevision: 3, snapshot: draft, publishedAt: new Date() });
    await expect(version.validate()).resolves.toBeUndefined();
    expect(serializeTenantPublicSite({ name: "Studio", publicSite: version.snapshot }).header).toEqual(saved.header);
  });

  it("safely normalizes malformed persisted groups and excess buttons without inventing destinations", () => {
    const result = serializeTenantPublicSite({ name: "Studio", publicSite: { header: {
      layout: "unknown", backgroundColor: "red",
      customLinks: [
        { ...group(), href: leaf().href },
        { ...group("nested"), children: [{ ...leaf(), children: [leaf("nested")] }] },
        group("valid"),
        { ...leaf("first"), emphasis: "button" },
        { ...leaf("second"), emphasis: "button" },
      ],
    } } });
    expect(result.header.layout).toBe("default");
    expect(result.header.backgroundColor).toBe("");
    expect(result.header.customLinks.map((item) => item.id)).toEqual(["valid", "first", "second"]);
    expect(result.header.customLinks[1]?.emphasis).toBe("button");
    expect(result.header.customLinks[2]).not.toHaveProperty("emphasis");
  });
});
