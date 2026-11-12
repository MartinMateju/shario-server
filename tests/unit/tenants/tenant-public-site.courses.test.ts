import mongoose, { Schema } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import {
  tenantPublicSiteSchema,
  tenantPublicSiteEditorSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const Fixture = mongoose.model(
  "CoursePageConfigTest",
  new Schema({
    name: String,
    publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
    publicSiteEditor: {
      type: tenantPublicSiteEditorSchema,
      default: undefined,
    },
  }),
);
const locationId = "507f1f77bcf86cd799439011";
const override = {
  locationId,
  headline: {
    cs: "Kurzy na Václavské",
    en: "Courses at Václavská",
    nl: "Cursussen",
  },
  description: { cs: "Přijďte tvořit.", en: "Come and create." },
  heroImageUrl: "https://cdn.example.com/course.webp",
};
const config = { customerPortal: { courses: { locations: [override] } } };

describe("location-specific portal course page config", () => {
  afterAll(() => mongoose.deleteModel("CoursePageConfigTest"));

  it("defaults old studios to an enabled page and no location overrides", async () => {
    const doc = new Fixture({ name: "Studio" });
    await expect(doc.validate()).resolves.toBeUndefined();
    const portal = serializeTenantPublicSite(doc as never).customerPortal;
    expect(portal.pages.courses.enabled).toBe(true);
    expect(portal.navigation.courses.visible).toBe(true);
    expect(portal.courses.locations).toEqual([]);
  });

  it("preserves localized drafts independently of published config and immutable versions", async () => {
    expect(updateTenantPublicSiteSchema.parse(config)).toEqual(config);
    const doc = new Fixture({
      name: "Studio",
      publicSiteEditor: { draft: config, published: {} },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    const stored = Fixture.hydrate(doc.toObject());
    const draft = serializeTenantPublicSite(stored as never, {
      snapshot: "draft",
    });
    expect(draft.customerPortal.courses.locations[0]).toMatchObject(override);
    expect(
      serializeTenantPublicSite(stored as never).customerPortal.courses
        .locations,
    ).toEqual([]);
    const version = new TenantPublicSiteVersionModel({
      tenant: "507f1f77bcf86cd799439099",
      sourceDraftRevision: 1,
      snapshot: draft,
      publishedAt: new Date(),
    });
    await expect(version.validate()).resolves.toBeUndefined();
    expect(
      version.toObject().snapshot.customerPortal.courses.locations[0],
    ).toMatchObject(override);
  });

  it.each([
    [{ ...override, locationId: "foreign-slug" }],
    [override, override],
    [{ ...override, headline: { en: "<script>alert(1)</script>" } }],
    [{ ...override, heroImageUrl: "javascript:alert(1)" }],
    [{ ...override, unknown: true }],
    Array(101).fill(override),
  ])("rejects unsafe, duplicate or unbounded overrides", (locations) => {
    expect(
      updateTenantPublicSiteSchema.safeParse({
        customerPortal: { courses: { locations } },
      }).success,
    ).toBe(false);
  });

  it("allows clearing overrides and strips unsafe legacy content from public serialization", () => {
    expect(
      updateTenantPublicSiteSchema.parse({
        customerPortal: { courses: { locations: [] } },
      }),
    ).toBeDefined();
    const result = serializeTenantPublicSite({
      name: "Studio",
      publicSite: {
        customerPortal: {
          courses: {
            locations: [
              {
                ...override,
                heroImageUrl: "javascript:alert(1)",
                headline: { en: "<b>bad</b>" },
              },
              override,
              { locationId: "invalid" },
            ],
          },
        },
      },
    }).customerPortal.courses.locations;
    expect(result).toHaveLength(1);
    expect(result[0]?.heroImageUrl).toBe("");
    expect(result[0]?.headline.en).toBe("");
  });
});
