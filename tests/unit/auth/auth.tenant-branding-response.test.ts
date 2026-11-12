import { describe, expect, it } from "vitest";

import { serializeAuthTenant } from "@/modules/auth/controllers/auth.controller.js";

describe("authenticated tenant shell branding", () => {
  it.each([
    ["time", false],
    ["piece", false],
    ["both", false],
    [undefined, false],
  ])(
    "exposes derived My work access for %s without exposing onboarding answers",
    (pricingMode, enabled) => {
      const tenant = serializeAuthTenant({
        _id: "507f1f77bcf86cd799439011",
        modules: { firing: true, payments: false },
        workspaceIntent: { pricingMode: pricingMode as string | undefined },
      });
      expect(tenant.customerCapabilities).toEqual({ myWork: enabled });
      expect(tenant).not.toHaveProperty("workspaceIntent");
      expect(tenant.modules).toEqual({ firing: true, payments: false });
    },
  );
  it("returns published portal controls without exposing draft edits", () => {
    const source = {
      _id: "507f1f77bcf86cd799439011",
      name: "Studio",
      slug: "studio",
      publicSite: {
        customerPortal: {
          pages: { credits: { enabled: false } },
          navigation: { giftVouchers: { visible: false } },
        },
      },
      publicSiteEditor: {
        draft: { customerPortal: { pages: { calendar: { enabled: false } } } },
      },
    };
    const tenant = serializeAuthTenant(source);
    expect(tenant.publicSite.customerPortal.pages.credits.enabled).toBe(false);
    expect(
      tenant.publicSite.customerPortal.navigation.giftVouchers.visible,
    ).toBe(false);
    expect(tenant.publicSite.customerPortal.pages.calendar.enabled).toBe(true);
  });

  it("returns the sanitized public-site contract for draft portal branding", () => {
    const tenant = serializeAuthTenant({
      _id: "507f1f77bcf86cd799439011",
      name: "Studio Olivka",
      slug: "studio-olivka",
      publicSite: {
        branding: {
          displayName: "Olivka Ceramics",
          logoUrl: "https://cdn.example.com/olivka.svg",
          accentColor: "#123abc",
        },
        footer: {
          website: "javascript:alert(1)",
        },
      },
    });

    expect(tenant.publicSite.branding).toMatchObject({
      displayName: "Olivka Ceramics",
      logoUrl: "https://cdn.example.com/olivka.svg",
      accentColor: "#123ABC",
    });
    expect(tenant).not.toHaveProperty("publication");
  });
});
