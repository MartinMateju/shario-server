import mongoose, { Schema } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";
import {
  tenantPublicSiteSchema,
  tenantPublicSiteEditorSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const pages = [
  "courses", "memberships", "vouchers", "knowledge", "bookings", "waitingList",
  "credits", "account", "invoices", "notifications", "products",
] as const;
const emptyImages = Object.fromEntries(pages.map((page) => [page, ""]));
const images = Object.fromEntries(pages.map((page) => [page, `https://cdn.example.test/${page}.webp`]));
const Fixture = mongoose.model("PortalPageImagesTest", new Schema({
  name: String,
  publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
  publicSiteEditor: { type: tenantPublicSiteEditorSchema, default: undefined },
}));

describe("per-page public and customer hero images", () => {
  afterAll(() => mongoose.deleteModel("PortalPageImagesTest"));

  it("defaults legacy tenants to empty images without a booking calendar image", async () => {
    const document = new Fixture({ name: "Studio" });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject().publicSite.customerPortal.pageImages).toEqual(emptyImages);
    expect(serializeTenantPublicSite({ name: "Studio" }).customerPortal.pageImages).toEqual(emptyImages);
  });

  it("persists every page image in drafts and immutable versions without publishing it", async () => {
    const patch = { customerPortal: { pageImages: images } };
    expect(updateTenantPublicSiteSchema.parse(patch)).toEqual(patch);
    const document = new Fixture({
      name: "Studio",
      publicSiteEditor: { draft: patch, published: {} },
    });
    await expect(document.validate()).resolves.toBeUndefined();
    const hydrated = Fixture.hydrate(document.toObject());
    const draft = serializeTenantPublicSite(hydrated as never, { snapshot: "draft" });
    expect(draft.customerPortal.pageImages).toEqual(images);
    expect(serializeTenantPublicSite(hydrated as never).customerPortal.pageImages).toEqual(emptyImages);
    const version = new TenantPublicSiteVersionModel({
      tenant: "507f1f77bcf86cd799439099",
      sourceDraftRevision: 1,
      snapshot: draft,
      publishedAt: new Date(),
    });
    await expect(version.validate()).resolves.toBeUndefined();
    expect(version.toObject().snapshot.customerPortal.pageImages).toEqual(images);
  });

  it.each([
    {}, { calendar: "/photo.png" }, { book: "/photo.png" }, { unknown: "/photo.png" },
    { courses: "javascript:alert(1)" }, { courses: "data:image/png;base64,AAA" },
    { courses: "//foreign.example/photo.png" }, { courses: "http://insecure.example/photo.png" },
    { courses: "https://user:password@example.test/photo.png" },
    { courses: "https://example.test:444/photo.png" }, { courses: "/" + "x".repeat(2048) },
    { courses: null }, { courses: true }, { courses: { url: "/photo.png" } },
  ])("rejects unknown pages and unsafe or malformed image settings: %j", (pageImages) => {
    expect(updateTenantPublicSiteSchema.safeParse({ customerPortal: { pageImages } }).success).toBe(false);
  });

  it("accepts clearing one image and strips unsafe or unknown stored values", async () => {
    const patch = { customerPortal: { pageImages: { courses: "", memberships: "/images/members.webp" } } };
    expect(updateTenantPublicSiteSchema.parse(patch)).toEqual(patch);
    const publicImages = serializeTenantPublicSite({
      name: "Studio",
      publicSite: { customerPortal: { pageImages: {
        courses: "javascript:alert(1)", memberships: "/images/members.webp",
        calendar: "/never-show.webp", knowledge: null, products: "/" + "x".repeat(2048),
      } } },
    }).customerPortal.pageImages;
    expect(publicImages).toEqual({ ...emptyImages, memberships: "/images/members.webp" });
    const unsafeDocument = new Fixture({
      publicSite: { customerPortal: { pageImages: { courses: "javascript:alert(1)" } } },
    });
    await expect(unsafeDocument.validate()).rejects.toThrow();
  });
});
