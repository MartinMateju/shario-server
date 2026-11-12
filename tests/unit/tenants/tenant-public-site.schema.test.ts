import { describe, expect, it } from "vitest";

import TenantModel from "@/modules/tenants/tenant.model.js";

describe("tenant public-site schema", () => {
  it("adds controlled defaults to new tenants", () => {
    const tenant = new TenantModel({
      name: "Studio Olivka",
      slug: "studio-olivka",
    });

    expect(tenant.publicSite.branding.accentColor).toBe("#1F36D4");
    expect(tenant.publicSite.branding.buttonTextColor).toBe("");
    expect(tenant.publicSite.branding.displayName).toBe("");
    expect(tenant.publicSite.branding.logoSize).toBe(48);
    expect(tenant.publicSite.branding.stylePreset).toBe("classic-editorial-v1");
    expect(tenant.publicSite.header.navOrder).toEqual([
      "book",
      "courses",
      "memberships",
      "vouchers",
      "help",
    ]);
    expect(tenant.publicSite.header.primaryCta).toBe("auto");
    expect(tenant.publicSite.pages.vouchers.title).toMatchObject({
      cs: "",
      en: "",
    });
    expect(tenant.publicSite.footer.legal.privacy).toBe("");
  });

  it("rejects an invalid logo size at the persistence boundary", async () => {
    const tenant = new TenantModel({
      name: "Studio Olivka",
      slug: "studio-olivka",
      publicSite: {
        branding: {
          logoSize: 73,
        },
      },
    });

    await expect(tenant.validate()).rejects.toMatchObject({
      errors: {
        "publicSite.branding.logoSize": expect.anything(),
      },
    });
  });

  it("accepts the expanded logo-size boundary", async () => {
    const tenant = new TenantModel({
      name: "Studio Olivka",
      slug: "studio-olivka",
      publicSite: { branding: { logoSize: 72 } },
    });

    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(tenant.publicSite.branding.logoSize).toBe(72);
  });

  it("rejects an unknown style preset at the persistence boundary", async () => {
    const tenant = new TenantModel({
      name: "Studio Olivka",
      slug: "studio-olivka",
      publicSite: {
        branding: {
          stylePreset: "future-experimental-v9",
        },
      },
    });

    await expect(tenant.validate()).rejects.toMatchObject({
      errors: {
        "publicSite.branding.stylePreset": expect.anything(),
      },
    });
  });

  it("stores valid presets independently in draft and published snapshots", async () => {
    const tenant = new TenantModel({
      name: "Studio Olivka",
      slug: "studio-olivka",
      publicSite: {
        branding: { stylePreset: "classic-editorial-v1" },
      },
      publicSiteEditor: {
        draft: {
          branding: { stylePreset: "modern-minimal-v1" },
        },
        published: {
          branding: { stylePreset: "warm-organic-v1" },
        },
      },
    });

    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(tenant.publicSite.branding.stylePreset).toBe("classic-editorial-v1");
    expect(tenant.publicSiteEditor?.draft?.branding.stylePreset).toBe(
      "modern-minimal-v1",
    );
    expect(tenant.publicSiteEditor?.published?.branding.stylePreset).toBe(
      "warm-organic-v1",
    );
  });
});
