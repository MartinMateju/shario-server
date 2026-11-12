import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  buildPublicTenantConfig: vi.fn(),
  getTenantPublicationState: vi.fn(),
  getTenantPublicSitePreviewData: vi.fn(),
  findOneAndUpdate: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/modules/tenants/services/tenant-currency.service.js", () => ({
  assertTenantOperationalCurrencyCanChange: vi.fn(),
}));
vi.mock("@/modules/tenants/settings/public-site-media-cleanup.js", () => ({
  cleanupDiscardedPublicSiteMedia: vi.fn(),
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock("@/modules/tenants/public-site/tenant-public-site.config.js", () => ({
  buildPublicTenantConfig: mocks.buildPublicTenantConfig,
}));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  getTenantPublicationState: mocks.getTenantPublicationState,
}));
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site-preview-data.service.js",
  () => ({
    getTenantPublicSitePreviewData: mocks.getTenantPublicSitePreviewData,
  }),
);

import {
  getTenantPublicSitePreview,
  updateTenantPublicSiteDraft,
} from "@/modules/tenants/settings/tenant-settings.service.js";

describe("tenant public-site settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      status: "active",
      publicationStatus: "live",
      hasExplicitState: true,
      publiclyAvailable: true,
    },
    {
      status: "active",
      publicationStatus: "draft",
      hasExplicitState: false,
      publiclyAvailable: false,
    },
    {
      status: "suspended",
      publicationStatus: "live",
      hasExplicitState: true,
      publiclyAvailable: false,
    },
  ])(
    "builds a current-tenant-only authenticated preview: %o",
    async ({
      status,
      publicationStatus,
      hasExplicitState,
      publiclyAvailable,
    }) => {
      const tenant = {
        _id: "507f1f77bcf86cd799439011",
        status,
      };
      const config = {
        id: "507f1f77bcf86cd799439011",
        slug: "studio-olivka",
      };
      mocks.getTenantOrThrow.mockResolvedValueOnce(tenant);
      mocks.buildPublicTenantConfig.mockResolvedValueOnce(config);
      mocks.getTenantPublicationState.mockResolvedValueOnce({
        status: publicationStatus,
        hasExplicitState,
      });
      mocks.getTenantPublicSitePreviewData.mockResolvedValueOnce({
        locations: [{ id: "location-1", name: "Main studio" }],
        products: [],
        courses: [],
        vouchers: [],
        memberships: [],
        membershipLocations: [],
        help: [],
      });

      await expect(
        getTenantPublicSitePreview("507f1f77bcf86cd799439011"),
      ).resolves.toEqual({
        tenant: config,
        preview: {
          mode: "authenticated",
          publicationStatus,
          hasExplicitPublicationState: hasExplicitState,
          publiclyAvailable,
          publishAction:
            publicationStatus === "live" ? "publishChanges" : "publishWebsite",
          data: {
            locations: [{ id: "location-1", name: "Main studio" }],
            products: [],
            courses: [],
            vouchers: [],
            memberships: [],
            membershipLocations: [],
            help: [],
          },
        },
      });
      expect(mocks.getTenantOrThrow).toHaveBeenCalledWith(
        "507f1f77bcf86cd799439011",
      );
      expect(mocks.buildPublicTenantConfig).toHaveBeenCalledWith(tenant, {
        snapshot: "draft",
      });
      expect(mocks.getTenantPublicationState).toHaveBeenCalledWith(tenant._id);
    },
  );

  it.each([true, false])("saves a guest checkout preference only to the draft while preserving course locations: %s", async (enabled) => {
    const location = {
      locationId: "507f1f77bcf86cd799439022",
      headline: { en: "Courses here" },
      heroImageUrl: "https://cdn.example.test/course.webp",
    };
    const tenant = {
      _id: "507f1f77bcf86cd799439011",
      name: "Clay",
      publicSiteEditor: {
        draftRevision: 2,
        publishedRevision: 1,
        draft: { customerPortal: { courses: { guestCheckoutEnabled: !enabled, locations: [location] } } },
        published: { customerPortal: { courses: { guestCheckoutEnabled: !enabled, locations: [location] } } },
      },
    };
    mocks.getTenantOrThrow.mockResolvedValueOnce(tenant);
    mocks.findOneAndUpdate.mockImplementationOnce((_filter: unknown, update: any) => ({
      exec: vi.fn().mockResolvedValue({
        ...tenant,
        publicSiteEditor: {
          ...tenant.publicSiteEditor,
          draft: update.$set["publicSiteEditor.draft"],
          draftRevision: 3,
        },
      }),
    }));
    const state = await updateTenantPublicSiteDraft({
      tenantId: tenant._id, revision: 2,
      patch: { customerPortal: { courses: { guestCheckoutEnabled: enabled } } },
    });
    expect(state.draft.customerPortal.courses.guestCheckoutEnabled).toBe(enabled);
    expect(state.draft.customerPortal.courses.locations[0]).toMatchObject(location);
    expect(state.published.customerPortal.courses.guestCheckoutEnabled).toBe(!enabled);
    expect(mocks.findOneAndUpdate.mock.calls[0]?.[1].$set).not.toHaveProperty("publicSiteEditor.published");
  });

  it("deep-merges a partial update without clearing sibling settings", async () => {
    const tenant: any = {
      _id: "507f1f77bcf86cd799439011",
      name: "Studio Olivka",
      publicSite: {
        branding: {
          displayName: "Olivka Ceramics",
          stylePreset: "warm-organic-v1",
          fontPreset: "editorial-serif-v1",
          logoUrl: "https://cdn.example.test/logo.svg",
          accentColor: "#1F36D4",
          labelColor: "#D27357",
          description: {
            cs: "Keramická dílna",
            en: "Pottery studio",
          },
        },
        login: {
          eyebrow: { cs: "Účet", en: "Account" },
          headline: {
            cs: "Vítejte",
            en: "Welcome",
          },
          labelColor: "#123ABC",
        },
        register: {
          eyebrow: { cs: "Začněte", en: "Get started" },
          headline: { cs: "Přidejte se", en: "Join us" },
          supportingText: { cs: "Český popis", en: "English description" },
          helpText: { cs: "Česká pomoc", en: "English help" },
          backgroundImageUrl: "https://cdn.example.test/register.webp",
          labelColor: "#ABCDEF",
        },
        header: {
          navOrder: ["book", "courses", "memberships", "help"],
          hiddenItems: [],
          primaryCta: "auto",
          announcement: {
            text: { cs: "Dnes zavřeno", en: "Closed today" },
            url: "/en/help",
          },
        },
        footer: {
          email: "hello@olivka.test",
          social: {
            instagram: "https://instagram.com/olivka",
          },
          legal: {
            terms: "/en/terms",
          },
        },
        pages: {
          home: {
            eyebrow: { cs: "Dílna", en: "Studio" },
            headline: { cs: "Olivka", en: "Olivka" },
            description: { cs: "Tvořte", en: "Create" },
            labelColor: "#654321",
            headlineColor: "#111111",
          },
        },
        customerPortal: {
          appearance: {
            headerBackgroundColor: "#F4EFE8",
            primaryButtonColor: "#1F36D4",
            calendarBackgroundColor: "#FFFAF5",
            profileMenuBackgroundColor: "#FFFFFF",
          },
          dashboard: {
            eyebrow: { cs: "Vítejte", en: "Welcome" },
            headline: { cs: "Vaše dílna", en: "Your studio" },
            description: { cs: "Vaše návštěvy", en: "Your visits" },
            labelColor: "#FEDCBA",
          },
        },
      },
      set: vi.fn(function (this: any, path: string, value: unknown) {
        const keys = path.split(".");
        let target = this;
        keys.slice(0, -1).forEach((key) => {
          target[key] ||= {};
          target = target[key];
        });
        target[keys.at(-1)!] = value;
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getTenantOrThrow.mockResolvedValueOnce(tenant);
    mocks.findOneAndUpdate.mockImplementationOnce(
      (_filter: unknown, update: any) => ({
        exec: vi.fn().mockResolvedValue({
          ...tenant,
          publicSiteEditor: {
            draft: update.$set["publicSiteEditor.draft"],
            draftRevision: 1,
            publishedRevision: 0,
            draftUpdatedAt: update.$set["publicSiteEditor.draftUpdatedAt"],
          },
        }),
      }),
    );

    const result = await updateTenantPublicSiteDraft({
      tenantId: "507f1f77bcf86cd799439011",
      patch: {
        branding: {
          description: { en: "Creative pottery studio" },
        },
        header: {
          announcement: {
            text: { cs: "Otevřeno" },
          },
        },
        footer: {
          social: {
            youtube: "https://youtube.com/@olivka",
          },
        },
        register: {
          headline: { en: "Create your account" },
        },
        pages: {
          home: {
            headlineColor: "#abc123",
          },
        },
        customerPortal: {
          appearance: {
            primaryButtonColor: "#D27357",
            profileMenuBackgroundColor: "#F8F3ED",
          },
          dashboard: {
            description: { cs: "Vaše rezervace a členství" },
          },
        },
      },
    });

    expect(result.draft.branding).toMatchObject({
      displayName: "Olivka Ceramics",
      stylePreset: "warm-organic-v1",
      fontPreset: "editorial-serif-v1",
      logoUrl: "https://cdn.example.test/logo.svg",
      description: {
        cs: "Keramická dílna",
        en: "Creative pottery studio",
      },
    });
    expect(result.draft.header.announcement).toMatchObject({
      text: { cs: "Otevřeno", en: "Closed today" },
      url: "/en/help",
    });
    expect(result.draft.footer.social).toEqual({
      instagram: "https://instagram.com/olivka",
      facebook: "",
      youtube: "https://youtube.com/@olivka",
      website: "",
    });
    expect(result.draft.footer.legal.terms).toBe("/en/terms");
    expect(result.draft.register).toMatchObject({
      eyebrow: { cs: "Začněte", en: "Get started" },
      headline: { cs: "Přidejte se", en: "Create your account" },
      supportingText: { cs: "Český popis", en: "English description" },
      backgroundImageUrl: "https://cdn.example.test/register.webp",
      labelColor: "#ABCDEF",
    });
    expect(result.draft.pages.home.headlineColor).toBe("#ABC123");
    expect(result.published.pages.home.headlineColor).toBe("#111111");
    expect(result.draft.customerPortal.dashboard).toMatchObject({
      eyebrow: { cs: "Vítejte", en: "Welcome" },
      headline: { cs: "Vaše dílna", en: "Your studio" },
      description: {
        cs: "Vaše rezervace a členství",
        en: "Your visits",
      },
      labelColor: "#FEDCBA",
    });
    expect(result.draft.customerPortal.appearance).toEqual({
      backgroundColor: "",
      surfaceColor: "",
      textColor: "",
      headingColor: "",
      headerTextColor: "",
      calendarTextColor: "",
      headerBackgroundColor: "#F4EFE8",
      primaryButtonColor: "#D27357",
      calendarBackgroundColor: "#FFFAF5",
      profileMenuBackgroundColor: "#F8F3ED",
    });
    expect(result.published.customerPortal.appearance).toEqual({
      backgroundColor: "",
      surfaceColor: "",
      textColor: "",
      headingColor: "",
      headerTextColor: "",
      calendarTextColor: "",
      headerBackgroundColor: "#F4EFE8",
      primaryButtonColor: "#1F36D4",
      calendarBackgroundColor: "#FFFAF5",
      profileMenuBackgroundColor: "#FFFFFF",
    });
    expect(result.published.branding.displayName).toBe("Olivka Ceramics");
    expect(result.published.branding.stylePreset).toBe("warm-organic-v1");
    expect(mocks.findOneAndUpdate).toHaveBeenCalledOnce();
  });

  it("keeps blank customer-facing copy blank across a saved draft round trip", async () => {
    const tenant: any = {
      _id: "507f1f77bcf86cd799439011",
      name: "Studio Olivka",
      publicSite: {
        branding: {
          displayName: "",
          accentColor: "#1F36D4",
          description: { cs: "", en: "" },
        },
        login: {
          headline: { cs: "", en: "" },
          supportingText: { cs: "", en: "" },
          helpText: { cs: "", en: "" },
        },
        header: {
          navOrder: ["book", "courses", "memberships", "help"],
          hiddenItems: [],
          primaryCta: "auto",
          announcement: {
            text: { cs: "", en: "" },
            url: "",
          },
        },
        footer: {
          description: { cs: "", en: "" },
          openingHours: { cs: "", en: "" },
          copyright: { cs: "", en: "" },
          email: "",
          phone: "",
          address: "",
          social: {
            instagram: "",
            facebook: "",
            youtube: "",
            website: "",
          },
          legal: {
            studioRules: "",
            terms: "",
            privacy: "",
            cancellation: "",
          },
        },
      },
      set: vi.fn(function (this: any, path: string, value: unknown) {
        const keys = path.split(".");
        let target = this;
        keys.slice(0, -1).forEach((key) => {
          target[key] ||= {};
          target = target[key];
        });
        target[keys.at(-1)!] = value;
      }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getTenantOrThrow.mockResolvedValueOnce(tenant);
    mocks.findOneAndUpdate.mockImplementationOnce(
      (_filter: unknown, update: any) => ({
        exec: vi.fn().mockResolvedValue({
          ...tenant,
          publicSiteEditor: {
            draft: update.$set["publicSiteEditor.draft"],
            draftRevision: 1,
            publishedRevision: 0,
            draftUpdatedAt: update.$set["publicSiteEditor.draftUpdatedAt"],
          },
        }),
      }),
    );

    const result = await updateTenantPublicSiteDraft({
      tenantId: "507f1f77bcf86cd799439011",
      patch: {
        footer: { address: "Olivova 1, Brno" },
      },
    });

    expect(result.draft.login.headline).toEqual({
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
    });
    expect(result.draft.login.supportingText).toEqual({
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
    });
    expect(tenant.publicSite.login.headline.en).toBe("");
    expect(result.draft.footer.address).toBe("Olivova 1, Brno");
    expect(result.published.footer.address).toBe("");
  });
});
