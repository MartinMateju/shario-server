import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteObjectFromR2: vi.fn(),
  findVersions: vi.fn(),
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  deleteObjectFromR2: mocks.deleteObjectFromR2,
}));
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site-version.model.js",
  () => ({
    default: {
      find: mocks.findVersions,
    },
  }),
);

import { cleanupDiscardedPublicSiteMedia } from "@/modules/tenants/settings/public-site-media-cleanup.js";

const originalPublicUrl = process.env.R2_PUBLIC_URL;

const site = (urls: Partial<Record<string, string>> = {}) =>
  ({
    branding: {
      logoUrl: urls.logo ?? "",
      faviconUrl: urls.favicon ?? "",
      coverImageUrl: urls.cover ?? "",
    },
    login: {
      backgroundImageUrl: urls.login ?? "",
    },
    register: {
      backgroundImageUrl: urls.register ?? "",
    },
    customerPortal: { courses: { locations: [{ heroImageUrl: urls.courseHero ?? "" }] } },
  }) as never;

describe("public-site media reference cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.R2_PUBLIC_URL = "https://media.shario.test";
    mocks.deleteObjectFromR2.mockResolvedValue(undefined);
    mocks.findVersions.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve([]) }),
      }),
    });
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.R2_PUBLIC_URL;
    } else {
      process.env.R2_PUBLIC_URL = originalPublicUrl;
    }
  });

  it("deletes a discarded tenant-owned draft object", async () => {
    const old = "https://media.shario.test/public-sites/tenant-1/logo/old.png";

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({ logo: old }),
      afterDraft: site(),
      published: site(),
    });

    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({
      key: "public-sites/tenant-1/logo/old.png",
    });
  });

  it("retains an object referenced by either resulting snapshot", async () => {
    const old = "https://media.shario.test/public-sites/tenant-1/cover/old.png";

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({ cover: old }),
      afterDraft: site(),
      published: site({ cover: old }),
    });

    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();
  });

  it("retains an object referenced by a published version", async () => {
    const old = "https://media.shario.test/public-sites/tenant-1/logo/old.png";
    mocks.findVersions.mockReturnValueOnce({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve([{ snapshot: site({ logo: old }) }]),
        }),
      }),
    });

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({ logo: old }),
      afterDraft: site(),
      published: site(),
    });

    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();
  });

  it("cleans discarded registration media but retains the published object", async () => {
    const old =
      "https://media.shario.test/public-sites/tenant-1/registerBackground/old.webp";

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({ register: old }),
      afterDraft: site(),
      published: site({ register: old }),
    });
    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({ register: old }),
      afterDraft: site(),
      published: site(),
    });
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({
      key: "public-sites/tenant-1/registerBackground/old.webp",
    });
  });

  it("never deletes external or differently scoped tenant objects", async () => {
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: site({
        logo: "https://media.shario.test/public-sites/tenant-2/logo/private.png",
        cover: "https://cdn.example.test/public/cover.png",
      }),
      afterDraft: site(),
      published: site(),
    });

    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();
  });

  it("retains a course hero referenced by a published version and deletes only abandoned draft images", async () => {
    const hero = "https://media.shario.test/public-sites/tenant-1/courseHero/photo.png";
    mocks.findVersions.mockReturnValueOnce({
      select: () => ({ lean: () => ({ exec: async () => [{ snapshot: {
        customerPortal: { courses: { locations: [{ heroImageUrl: hero }] } },
      } }] }) }),
    });
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1", beforeDraft: site({ courseHero: hero }),
      afterDraft: site(), published: site(),
    });
    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1", beforeDraft: site({ courseHero: hero }),
      afterDraft: site(), published: site(),
    });
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({ key: "public-sites/tenant-1/courseHero/photo.png" });
  });

  it("retains page images referenced by another page, publication or version and deletes only abandoned tenant assets", async () => {
    const hero = "https://media.shario.test/public-sites/tenant-1/membershipsHero/photo.png";
    const pageSite = (pageImages: Record<string, string>) => ({ customerPortal: { pageImages } }) as never;
    const beforeDraft = pageSite({ memberships: hero });
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1", beforeDraft, afterDraft: pageSite({ vouchers: hero }), published: site(),
    });
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1", beforeDraft, afterDraft: site(), published: pageSite({ memberships: hero }),
    });
    const select = vi.fn(() => ({ lean: () => ({ exec: async () => [
      { snapshot: pageSite({ memberships: hero }) },
    ] }) }));
    mocks.findVersions.mockReturnValueOnce({ select });
    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1", beforeDraft, afterDraft: site(), published: site(),
    });
    expect(select).toHaveBeenCalledWith(expect.stringContaining("snapshot.customerPortal.pageImages"));
    expect(mocks.findVersions).toHaveBeenLastCalledWith({ tenant: "tenant-1" });
    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();

    await cleanupDiscardedPublicSiteMedia({
      tenantId: "tenant-1",
      beforeDraft: pageSite({
        memberships: hero,
        courses: "https://media.shario.test/public-sites/tenant-2/coursesHero/photo.png",
        credits: "https://cdn.example.test/photo.png",
      }),
      afterDraft: site(), published: site(),
    });
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledExactlyOnceWith({
      key: "public-sites/tenant-1/membershipsHero/photo.png",
    });
  });
});
