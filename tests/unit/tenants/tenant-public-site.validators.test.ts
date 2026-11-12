import { describe, expect, it } from "vitest";

import {
  publicSiteVersionParamsSchema,
  updateTenantPublicSiteSchema,
} from "@/modules/tenants/public-site/tenant-public-site.validators.js";

describe("tenant public-site settings validation", () => {
  it("accepts a bounded, localized deep-partial update", () => {
    const value = updateTenantPublicSiteSchema.parse({
      branding: {
        displayName: "Studio Olivka",
        stylePreset: "modern-minimal-v1",
        fontPreset: "shario-sans-v1",
        accentColor: "#1f36d4",
        labelColor: "#d27357",
        buttonTextColor: "#fefefe",
        logoUrl: "https://cdn.example.test/olivka.svg",
        logoSize: 72,
        description: {
          cs: "Keramická dílna v Brně",
        },
      },
      header: {
        navOrder: ["courses", "book", "memberships", "vouchers", "help"],
        hiddenItems: ["help"],
        primaryCta: "vouchers",
        announcement: {
          text: { en: "Summer opening hours" },
          url: "/en/help/summer-hours",
        },
      },
      footer: {
        email: "INFO@OLIVKA.TEST",
        legal: {
          terms: "/en/terms",
          privacy: "https://olivka.test/privacy",
        },
      },
      pages: {
        home: {
          labelColor: "#123abc",
          headlineColor: "#fedcba",
          sectionOrder: ["about", "waysToVisit", "locations"],
          hiddenSections: ["locations"],
          sectionContent: {
            about: {
              title: { en: "About the studio" },
              description: { cs: "Tvoříme spolu." },
            },
          },
        },
        vouchers: {
          title: { en: "Gift vouchers" },
          description: { cs: "Darujte čas na tvoření." },
        },
      },
      login: {
        eyebrow: { en: "Your creative account" },
        labelColor: "",
      },
      register: {
        headline: { en: "Join Studio Olivka" },
        backgroundImageUrl: "https://cdn.example.test/register.webp",
        labelColor: "#ABCDEF",
      },
      customerPortal: {
        appearance: {
          headerBackgroundColor: "#f4efe8",
          primaryButtonColor: "#1f36d4",
          calendarBackgroundColor: "",
          profileMenuBackgroundColor: "#fffaf5",
        },
        dashboard: {
          eyebrow: { cs: "Vítejte zpět" },
          headline: { en: "Your studio day" },
          description: { en: "Bookings, memberships and studio work." },
          labelColor: "",
        },
      },
    });

    expect(value.branding?.accentColor).toBe("#1F36D4");
    expect(value.branding?.stylePreset).toBe("modern-minimal-v1");
    expect(value.branding?.fontPreset).toBe("shario-sans-v1");
    expect(value.branding?.logoSize).toBe(72);
    expect(value.branding?.labelColor).toBe("#D27357");
    expect(value.branding?.buttonTextColor).toBe("#FEFEFE");
    expect(value.pages?.home?.labelColor).toBe("#123ABC");
    expect(value.pages?.home?.headlineColor).toBe("#FEDCBA");
    expect(value.pages?.home).toMatchObject({
      sectionOrder: ["about", "waysToVisit", "locations"],
      hiddenSections: ["locations"],
      sectionContent: {
        about: {
          title: { en: "About the studio" },
          description: { cs: "Tvoříme spolu." },
        },
      },
    });
    expect(value.register?.labelColor).toBe("#ABCDEF");
    expect(value.customerPortal?.appearance).toEqual({
      headerBackgroundColor: "#F4EFE8",
      primaryButtonColor: "#1F36D4",
      calendarBackgroundColor: "",
      profileMenuBackgroundColor: "#FFFAF5",
    });
    expect(value.footer?.email).toBe("info@olivka.test");
    expect(value.branding?.description).toEqual({
      cs: "Keramická dílna v Brně",
    });
    expect(value.pages?.vouchers).toEqual({
      title: { en: "Gift vouchers" },
      description: { cs: "Darujte čas na tvoření." },
    });
  });

  it.each([
    "classic-editorial-v1",
    "modern-minimal-v1",
    "warm-organic-v1",
  ] as const)("accepts the stable style preset %s", (stylePreset) => {
    expect(
      updateTenantPublicSiteSchema.parse({
        branding: { stylePreset },
      }).branding?.stylePreset,
    ).toBe(stylePreset);
  });

  it("migrates the complete legacy navigation order", () => {
    const value = updateTenantPublicSiteSchema.parse({
      header: {
        navOrder: ["book", "courses", "memberships", "help"],
      },
    });

    expect(value.header?.navOrder).toEqual([
      "book",
      "courses",
      "memberships",
      "vouchers",
      "help",
    ]);
  });

  it("preserves a custom legacy navigation order while adding vouchers", () => {
    const value = updateTenantPublicSiteSchema.parse({
      header: {
        navOrder: ["help", "memberships", "courses", "book"],
      },
    });

    expect(value.header?.navOrder).toEqual([
      "help",
      "memberships",
      "courses",
      "book",
      "vouchers",
    ]);
  });

  it.each([
    {},
    { branding: {} },
    { footer: { legal: {} } },
    { customCss: "body { display: none }" },
    { login: { headline: { en: "<script>alert(1)</script>" } } },
    { branding: { logoUrl: "javascript:alert(1)" } },
    { branding: { logoSize: 23 } },
    { branding: { logoSize: 73 } },
    { branding: { logoSize: 40.5 } },
    { branding: { coverImageUrl: "//evil.example/image.jpg" } },
    { footer: { social: { instagram: "/relative-profile" } } },
    { branding: { accentColor: "#fff" } },
    { branding: { stylePreset: "modern-minimal" } },
    { branding: { fontPreset: "Architectonic" } },
    { branding: { fontPreset: "var(--attacker-font)" } },
    { branding: { labelColor: "red" } },
    { pages: { home: { headlineColor: "red" } } },
    { branding: { buttonTextColor: "#FFF" } },
    { branding: { buttonTextColor: "transparent" } },
    { register: { backgroundImageUrl: "data:image/png;base64,abc" } },
    { register: { headline: { en: "<style>body{display:none}</style>" } } },
    { customerPortal: { dashboard: { customCss: "display:none" } } },
    { customerPortal: { appearance: { customCss: "display:none" } } },
    {
      customerPortal: {
        appearance: { calendarBackgroundColor: "rgba(0, 0, 0, .5)" },
      },
    },
    {
      header: {
        navOrder: ["book", "book", "courses", "vouchers", "help"],
      },
    },
    { header: { navOrder: ["book", "courses"] } },
    { header: { hiddenItems: ["book", "book"] } },
    { pages: { home: { sectionOrder: ["about", "about"] } } },
    { pages: { home: { hiddenSections: ["custom-html"] } } },
    {
      pages: {
        home: {
          sectionContent: {
            faq: { title: { en: "<style>body{display:none}</style>" } },
          },
        },
      },
    },
  ])("rejects unsafe, unknown or empty input: %o", (input) => {
    expect(() => updateTenantPublicSiteSchema.parse(input)).toThrow();
  });

  it("accepts only canonical Mongo version ids", () => {
    expect(
      publicSiteVersionParamsSchema.parse({
        versionId: "64ad12ef34ab56cd78ef9012",
      }),
    ).toEqual({ versionId: "64ad12ef34ab56cd78ef9012" });
    expect(() =>
      publicSiteVersionParamsSchema.parse({ versionId: "latest" }),
    ).toThrow();
  });

  it("allows an empty string to clear optional links and text", () => {
    expect(
      updateTenantPublicSiteSchema.parse({
        branding: { logoUrl: "", buttonTextColor: "" },
        login: { helpText: { cs: "" } },
        register: { labelColor: "" },
        pages: { home: { labelColor: "", headlineColor: "" } },
        customerPortal: {
          appearance: {
            headerBackgroundColor: "",
            primaryButtonColor: "",
            calendarBackgroundColor: "",
            profileMenuBackgroundColor: "",
          },
          dashboard: { labelColor: "" },
        },
        footer: {
          email: "",
          social: { instagram: "" },
        },
      }),
    ).toMatchObject({
      branding: { logoUrl: "", buttonTextColor: "" },
      login: { helpText: { cs: "" } },
      register: { labelColor: "" },
      pages: { home: { labelColor: "", headlineColor: "" } },
      customerPortal: {
        appearance: {
          headerBackgroundColor: "",
          primaryButtonColor: "",
          calendarBackgroundColor: "",
          profileMenuBackgroundColor: "",
        },
        dashboard: { labelColor: "" },
      },
      footer: { email: "", social: { instagram: "" } },
    });
  });
});
