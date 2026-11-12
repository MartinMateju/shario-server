import { describe, expect, it } from "vitest";

import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";

describe("tenant public-site serialization", () => {
  it("preserves the expanded maximum logo size", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: { branding: { logoSize: 72 } },
    } as any);

    expect(result.branding.logoSize).toBe(72);
  });

  it("provides stable defaults for tenants created before public-site settings", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
    } as any);

    expect(result).toMatchObject({
      branding: {
        displayName: "Studio Olivka",
        stylePreset: "classic-editorial-v1",
        fontPreset: "shario-sans-v1",
        logoUrl: "",
        logoSize: 48,
        faviconUrl: "",
        accentColor: "#1F36D4",
        buttonTextColor: "",
        labelColor: "#1F36D4",
        coverImageUrl: "",
        description: { cs: "", en: "" },
      },
      login: {
        eyebrow: { cs: "", en: "" },
        headline: { cs: "", en: "" },
        supportingText: { cs: "", en: "" },
        labelColor: "",
      },
      register: {
        eyebrow: { cs: "", en: "" },
        headline: { cs: "", en: "" },
        supportingText: { cs: "", en: "" },
        helpText: { cs: "", en: "" },
        backgroundImageUrl: "",
        labelColor: "",
      },
      header: {
        navOrder: ["book", "courses", "memberships", "vouchers", "help"],
        hiddenItems: [],
        primaryCta: "auto",
      },
      footer: {
        email: "",
        phone: "",
        address: "",
      },
      pages: {
        home: {
          labelColor: "",
          headlineColor: "",
          sectionOrder: [
            "waysToVisit",
            "featured",
            "about",
            "gallery",
            "testimonials",
            "locations",
            "team",
            "faq",
          ],
          hiddenSections: [
            "featured",
            "about",
            "gallery",
            "testimonials",
            "locations",
            "team",
            "faq",
          ],
        },
      },
      customerPortal: {
        appearance: {
          headerBackgroundColor: "",
          primaryButtonColor: "",
          calendarBackgroundColor: "",
          profileMenuBackgroundColor: "",
        },
        dashboard: {
          eyebrow: { cs: "", en: "" },
          headline: { cs: "", en: "" },
          description: { cs: "", en: "" },
          labelColor: "",
        },
      },
    });
  });

  it("completes partial section orders and hides sections unknown to the stored contract", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: {
        pages: {
          home: {
            sectionOrder: ["about", "waysToVisit"],
            hiddenSections: [],
            sectionContent: {
              about: {
                title: { en: "About Olivka" },
                description: { cs: "Keramika bez spěchu." },
              },
              attacker: { title: { en: "Injected" } },
            },
          },
        },
      },
    } as any);

    expect(result.pages.home.sectionOrder.slice(0, 2)).toEqual([
      "about",
      "waysToVisit",
    ]);
    expect(result.pages.home.hiddenSections).toEqual(
      expect.arrayContaining([
        "featured",
        "gallery",
        "testimonials",
        "locations",
        "team",
        "faq",
      ]),
    );
    expect(result.pages.home.sectionContent.about.title.en).toBe(
      "About Olivka",
    );
    expect(result.pages.home.sectionContent).not.toHaveProperty("attacker");
  });

  it("preserves safe customization and fails closed for corrupt legacy values", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: {
        branding: {
          displayName: "Olivka",
          stylePreset: "future-experimental-v9",
          fontPreset: "url(https://evil.example/font.woff2)",
          logoUrl: "javascript:alert(1)",
          logoSize: 99,
          coverImageUrl: "https://cdn.example.test/cover.jpg",
          accentColor: "not-a-colour",
          buttonTextColor: "transparent",
          labelColor: "currentColor",
          description: {
            cs: "<img src=x onerror=alert(1)>",
            en: "A quiet pottery studio",
          },
        },
        register: {
          eyebrow: { en: "Create your account" },
          backgroundImageUrl: "javascript:alert(1)",
          labelColor: "#00aa44",
        },
        pages: {
          home: {
            labelColor: "#123abc",
            headlineColor: "#fedcba",
          },
        },
        customerPortal: {
          appearance: {
            headerBackgroundColor: "#f4efe8",
            primaryButtonColor: "not-a-colour",
            calendarBackgroundColor: "#fffaf5",
            profileMenuBackgroundColor: "currentColor",
          },
          dashboard: {
            headline: { en: "Studio overview" },
            description: { en: "<script>alert(1)</script>" },
            labelColor: "invalid",
          },
        },
        header: {
          navOrder: ["courses", "courses", "unknown"],
          hiddenItems: ["help", "help", "unknown"],
          primaryCta: "external",
          announcement: {
            url: "//evil.example",
          },
        },
        footer: {
          email: "not-an-email",
          phone: "x".repeat(81),
          address: "x".repeat(501),
          social: {
            instagram: "/relative",
            website: "https://olivka.test",
          },
        },
      },
    } as any);

    expect(result.branding).toMatchObject({
      displayName: "Olivka",
      stylePreset: "classic-editorial-v1",
      fontPreset: "shario-sans-v1",
      logoUrl: "",
      logoSize: 48,
      coverImageUrl: "https://cdn.example.test/cover.jpg",
      accentColor: "#1F36D4",
      buttonTextColor: "",
      labelColor: "#1F36D4",
      description: { cs: "", en: "A quiet pottery studio" },
    });
    expect(result.header).toMatchObject({
      navOrder: ["courses", "book", "memberships", "vouchers", "help"],
      hiddenItems: ["help"],
      primaryCta: "auto",
      announcement: { url: "" },
    });
    expect(result.footer.social).toEqual({
      instagram: "",
      facebook: "",
      youtube: "",
      website: "https://olivka.test",
    });
    expect(result.footer.email).toBe("");
    expect(result.footer.phone).toBe("");
    expect(result.footer.address).toBe("");
    expect(result.register).toMatchObject({
      eyebrow: { cs: "", en: "Create your account" },
      backgroundImageUrl: "",
      labelColor: "#00AA44",
    });
    expect(result.pages.home.labelColor).toBe("#123ABC");
    expect(result.pages.home.headlineColor).toBe("#FEDCBA");
    expect(result.customerPortal.appearance).toEqual({
      backgroundColor: "",
      surfaceColor: "",
      textColor: "",
      headingColor: "",
      headerTextColor: "",
      calendarTextColor: "",
      headerBackgroundColor: "#F4EFE8",
      primaryButtonColor: "",
      calendarBackgroundColor: "#FFFAF5",
      profileMenuBackgroundColor: "",
    });
    expect(result.customerPortal.dashboard).toEqual({
      eyebrow: {
        en: "",
        cs: "",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
      headline: {
        en: "Studio overview",
        cs: "",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
      description: {
        en: "",
        cs: "",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
      labelColor: "",
    });
  });

  it("normalizes a valid button text colour override", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: {
        branding: { buttonTextColor: "#fefefe" },
      },
    } as any);

    expect(result.branding.buttonTextColor).toBe("#FEFEFE");
  });

  it.each([
    "classic-editorial-v1",
    "modern-minimal-v1",
    "warm-organic-v1",
  ] as const)("preserves the valid stored style preset %s", (stylePreset) => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: {
        branding: { stylePreset },
      },
    } as any);

    expect(result.branding.stylePreset).toBe(stylePreset);
  });

  it("places vouchers before help when upgrading a complete legacy navigation order", () => {
    const result = serializeTenantPublicSite({
      name: "Studio Olivka",
      publicSite: {
        pages: {
          vouchers: {
            title: { en: "Gift vouchers" },
            description: { cs: "Darujte čas na tvoření." },
          },
        },
        header: {
          navOrder: ["book", "courses", "memberships", "help"],
        },
      },
    } as any);

    expect(result.header.navOrder).toEqual([
      "book",
      "courses",
      "memberships",
      "vouchers",
      "help",
    ]);
    expect(result.pages.vouchers).toEqual({
      visible: true,
      title: {
        en: "Gift vouchers",
        cs: "",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
      description: {
        en: "",
        cs: "Darujte čas na tvoření.",
        de: "",
        pl: "",
        sk: "",
        da: "",
        fr: "",
        es: "",
        it: "",
        "pt-PT": "",
        sv: "",
        nb: "",
        fi: "",
        hu: "",
        el: "",
        tr: "",
        nl: "",
        ro: "",
      },
    });
  });
});
