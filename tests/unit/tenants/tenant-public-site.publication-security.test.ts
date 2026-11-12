import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_PORTAL_NAVIGATION_KEYS,
  CUSTOMER_PORTAL_PAGE_IDS,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import type { TenantPublicSite } from "@/modules/tenants/tenant.types.js";
import { PORTAL_APPEARANCE_COLOR_KEYS } from "@/shared/appearance/portal-appearance.js";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  findOneAndUpdate: vi.fn(),
  getTenantPublicationState: vi.fn(),
  publicTenantCacheKey: vi.fn(),
  deleteCache: vi.fn(),
  buildPublicTenantConfig: vi.fn(),
  getTenantPublicSitePreviewData: vi.fn(),
  cleanupDiscardedPublicSiteMedia: vi.fn(),
  versionFind: vi.fn(),
  versionFindOne: vi.fn(),
  versionFindOneAndUpdate: vi.fn(),
  startSession: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
  assertTenantLocationIdsExist: vi.fn(),
}));

vi.mock("@/modules/tenant-access/services/location-scope.service.js", () => ({
  assertTenantLocationIdsExist: mocks.assertTenantLocationIdsExist,
}));

vi.mock("mongoose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongoose")>();

  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: mocks.startSession,
    },
  };
});

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/modules/tenants/services/tenant-currency.service.js", () => ({
  assertTenantOperationalCurrencyCanChange: vi.fn(),
}));
vi.mock("@/modules/tenants/settings/public-site-media-cleanup.js", () => ({
  cleanupDiscardedPublicSiteMedia: mocks.cleanupDiscardedPublicSiteMedia,
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  getTenantPublicationState: mocks.getTenantPublicationState,
  publicTenantCacheKey: mocks.publicTenantCacheKey,
}));
vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: mocks.deleteCache,
}));
vi.mock("@/modules/tenants/public-site/tenant-public-site.config.js", () => ({
  buildPublicTenantConfig: mocks.buildPublicTenantConfig,
}));
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site-preview-data.service.js",
  () => ({
    getTenantPublicSitePreviewData: mocks.getTenantPublicSitePreviewData,
  }),
);
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site-version.model.js",
  () => ({
    default: {
      find: mocks.versionFind,
      findOne: mocks.versionFindOne,
      findOneAndUpdate: mocks.versionFindOneAndUpdate,
    },
  }),
);

import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import {
  getTenantPublicSiteEditorState,
  getTenantPublicSitePreview,
  listTenantPublicSiteVersions,
  publishTenantPublicSiteDraft,
  resetTenantPublicSiteDraft,
  restoreTenantPublicSiteVersion,
  updateTenantPublicSiteDraft,
} from "@/modules/tenants/settings/tenant-settings.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const ownerId = "507f1f77bcf86cd799439012";

const legacyPublicSite = {
  branding: {
    displayName: "Published legacy identity",
    logoUrl: "",
    faviconUrl: "",
    accentColor: "#1F36D4",
    secondaryColor: "#D27357",
    backgroundColor: "#FCFBF8",
    textColor: "#1F1F1F",
    coverImageUrl: "",
    description: {
      cs: "Publikovaný popis",
      en: "Published description",
    },
  },
  login: {
    headline: {
      cs: "Publikované přihlášení",
      en: "Published login",
    },
    supportingText: { cs: "", en: "" },
    helpText: { cs: "", en: "" },
    backgroundImageUrl: "",
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
  pages: {
    home: {
      eyebrow: { cs: "", en: "" },
      headline: {
        cs: "Publikovaný domov",
        en: "Published home",
      },
      description: { cs: "", en: "" },
    },
    book: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    courses: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    memberships: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    help: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
  },
};

const setPath = (target: Record<string, any>, path: string, value: unknown) => {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  cursor[segments.at(-1)!] = structuredClone(value);
};

const unsetPath = (target: Record<string, any>, path: string) => {
  const segments = path.split(".");
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== "object") return;
    cursor = cursor[segment];
  }
  delete cursor[segments.at(-1)!];
};

describe("tenant public-site draft publication lifecycle", () => {
  let tenant: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publicTenantCacheKey.mockImplementation(
      (slug: string) => `shario:public-tenant:${slug.trim().toLowerCase()}`,
    );
    mocks.deleteCache.mockResolvedValue(undefined);
    mocks.assertTenantLocationIdsExist.mockResolvedValue([]);
    mocks.withTransaction.mockImplementation(
      async (work: () => Promise<void>) => work(),
    );
    mocks.startSession.mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    });
    mocks.getTenantPublicSitePreviewData.mockResolvedValue({
      locations: [],
      products: [],
      courses: [],
      memberships: [],
      vouchers: [],
      help: { contactEmail: "", contactPhone: "" },
    });
    mocks.versionFindOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ _id: "version-created" }),
    });
    tenant = {
      _id: tenantId,
      name: "Studio Olivka",
      slug: "studio-olivka",
      status: "active",
      settings: {
        defaultLanguage: "en",
        currency: "CZK",
        timezone: "Europe/Prague",
      },
      publicSite: structuredClone(legacyPublicSite),
    };
    mocks.getTenantOrThrow.mockImplementation(async (requestedId: string) => {
      expect(requestedId).toBe(tenantId);
      return tenant;
    });
    mocks.getTenantPublicationState.mockResolvedValue({
      status: "live",
      hasExplicitState: true,
    });
    mocks.buildPublicTenantConfig.mockImplementation(
      async (source: Record<string, any>, options = {}) => ({
        id: String(source._id),
        slug: source.slug,
        publicSite: serializeTenantPublicSite(source as never, options),
      }),
    );
    mocks.findOneAndUpdate.mockImplementation(
      (
        filter: Record<string, any>,
        update: {
          $set?: Record<string, unknown>;
          $unset?: Record<string, unknown>;
          $inc?: Record<string, number>;
        },
      ) => ({
        exec: async () => {
          expect(String(filter._id)).toBe(tenantId);
          const actualRevision = tenant.publicSiteEditor?.draftRevision ?? 0;
          const expectedRevision = filter["publicSiteEditor.draftRevision"];
          const matchesRevision =
            typeof expectedRevision === "number"
              ? expectedRevision === actualRevision
              : Array.isArray(filter.$or) && actualRevision === 0;

          if (!matchesRevision) return null;

          Object.entries(update.$set ?? {}).forEach(([path, value]) => {
            setPath(tenant, path, value);
          });
          Object.keys(update.$unset ?? {}).forEach((path) => {
            unsetPath(tenant, path);
          });
          Object.entries(update.$inc ?? {}).forEach(([path, increment]) => {
            const current =
              path === "publicSiteEditor.draftRevision"
                ? (tenant.publicSiteEditor?.draftRevision ?? 0)
                : 0;
            setPath(tenant, path, current + increment);
          });
          return tenant;
        },
      }),
    );
  });

  it("invalidates only the published tenant's cache after the transaction commits", async () => {
    tenant.slug = " Studio-Olivka ";
    const faviconUrl =
      "https://media.example.test/public-sites/studio/favicon/new.png";
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: { branding: { faviconUrl } },
    });
    let committed = false;
    mocks.withTransaction.mockImplementationOnce(
      async (work: () => Promise<void>) => {
        await work();
        expect(mocks.deleteCache).not.toHaveBeenCalled();
        committed = true;
      },
    );
    mocks.deleteCache.mockImplementationOnce(async () => {
      expect(committed).toBe(true);
      expect(tenant.publicSite.branding.faviconUrl).toBe(faviconUrl);
    });

    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: saved.editor.draftRevision,
    });

    expect(published.published.branding.faviconUrl).toBe(faviconUrl);
    expect(mocks.publicTenantCacheKey).toHaveBeenCalledWith(tenant.slug);
    expect(mocks.deleteCache.mock.calls).toEqual([
      ["shario:public-tenant:studio-olivka"],
    ]);
  });

  it("does not invalidate the cache when commit fails after the publication callback", async () => {
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: {
        branding: {
          faviconUrl:
            "https://media.example.test/public-sites/studio/favicon/new.png",
        },
      },
    });
    const beforePublish = structuredClone(tenant);
    const commitError = new Error("Transaction commit failed");
    let callbackCompleted = false;
    mocks.withTransaction.mockImplementationOnce(
      async (work: () => Promise<void>) => {
        await work();
        callbackCompleted = true;
        expect(mocks.deleteCache).not.toHaveBeenCalled();
        tenant = beforePublish;
        throw commitError;
      },
    );

    await expect(
      publishTenantPublicSiteDraft({
        tenantId,
        userId: ownerId,
        revision: saved.editor.draftRevision,
      }),
    ).rejects.toBe(commitError);

    expect(callbackCompleted).toBe(true);
    expect(tenant.publicSite.branding.faviconUrl).toBe("");
    expect(mocks.deleteCache).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledOnce();
  });

  it.each(["stale revision", "compare-and-swap race"])(
    "does not invalidate the public cache after a publication %s",
    async (failure) => {
      const saved = await updateTenantPublicSiteDraft({
        tenantId,
        revision: 0,
        patch: { branding: { displayName: "Unpublished replacement" } },
      });
      if (failure === "compare-and-swap race") {
        mocks.findOneAndUpdate.mockReturnValueOnce({
          exec: vi.fn().mockResolvedValueOnce(null),
        });
      }

      await expect(
        publishTenantPublicSiteDraft({
          tenantId,
          userId: ownerId,
          revision:
            failure === "stale revision" ? 0 : saved.editor.draftRevision,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "PUBLIC_SITE_REVISION_CONFLICT",
      });

      expect(tenant.publicSite.branding.displayName).toBe(
        "Published legacy identity",
      );
      expect(mocks.deleteCache).not.toHaveBeenCalled();
    },
  );

  it("keeps logo redirects private until published and preserves the URL through disabling", async () => {
    const branding = {
      logoRedirectEnabled: true,
      logoRedirectUrl: "https://www.atelierklei.cz/",
    };
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: { branding },
    });
    expect(saved.draft.branding).toMatchObject(branding);
    expect(saved.published.branding.logoRedirectEnabled).toBe(false);
    expect(
      serializeTenantPublicSite(tenant as never).branding.logoRedirectEnabled,
    ).toBe(false);
    const preview = await getTenantPublicSitePreview(tenantId);
    expect(preview.tenant.publicSite.branding).toMatchObject(branding);
    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: saved.editor.draftRevision,
    });
    expect(published.published.branding).toMatchObject(branding);
    expect(serializeTenantPublicSite(tenant as never).branding).toMatchObject(
      branding,
    );
    expect(
      mocks.versionFindOneAndUpdate.mock.lastCall?.[1].$setOnInsert.snapshot
        .branding,
    ).toMatchObject(branding);

    const disabled = await updateTenantPublicSiteDraft({
      tenantId,
      revision: published.editor.draftRevision,
      patch: { branding: { logoRedirectEnabled: false } },
    });
    expect(disabled.draft.branding).toMatchObject({
      ...branding,
      logoRedirectEnabled: false,
    });
    const enabledAgain = await updateTenantPublicSiteDraft({
      tenantId,
      revision: disabled.editor.draftRevision,
      patch: { branding: { logoRedirectEnabled: true } },
    });
    expect(enabledAgain.draft.branding).toMatchObject(branding);
  });

  it("rejects enabling without a saved URL and clearing a URL while still enabled", async () => {
    await expect(
      updateTenantPublicSiteDraft({
        tenantId,
        patch: { branding: { logoRedirectEnabled: true } },
      }),
    ).rejects.toThrow("destination URL");
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      patch: {
        branding: {
          logoRedirectEnabled: true,
          logoRedirectUrl: "https://www.atelierklei.cz/",
        },
      },
    });
    mocks.findOneAndUpdate.mockClear();
    await expect(
      updateTenantPublicSiteDraft({
        tenantId,
        revision: saved.editor.draftRevision,
        patch: { branding: { logoRedirectUrl: "" } },
      }),
    ).rejects.toThrow("destination URL");
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("validates course-location ownership and keeps draft heroes private until publishing", async () => {
    const locations = [
      {
        locationId: "507f1f77bcf86cd799439013",
        headline: { cs: "Kurzy na Václavské", en: "Courses at Václavská" },
        description: { en: "Make something beautiful." },
        heroImageUrl: "https://media.example.com/course.jpg",
      },
    ];
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: { customerPortal: { courses: { locations } } },
    });
    expect(mocks.assertTenantLocationIdsExist).toHaveBeenCalledWith(tenantId, [
      locations[0]!.locationId,
    ]);
    expect(saved.draft.customerPortal.courses.locations[0]).toMatchObject(
      locations[0]!,
    );
    expect(saved.published.customerPortal.courses.locations).toEqual([]);
    const preview = await getTenantPublicSitePreview(tenantId);
    expect(
      preview.tenant.publicSite.customerPortal.courses.locations[0],
    ).toMatchObject(locations[0]!);
    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: saved.editor.draftRevision,
    });
    expect(
      published.published.customerPortal.courses.locations[0],
    ).toMatchObject(locations[0]!);
    expect(
      mocks.versionFindOneAndUpdate.mock.lastCall?.[1].$setOnInsert.snapshot
        .customerPortal.courses.locations[0],
    ).toMatchObject(locations[0]!);

    mocks.findOneAndUpdate.mockClear();
    mocks.assertTenantLocationIdsExist.mockRejectedValueOnce(
      new Error("Location outside tenant"),
    );
    await expect(
      updateTenantPublicSiteDraft({
        tenantId,
        patch: { customerPortal: { courses: { locations } } },
      }),
    ).rejects.toThrow("Location outside tenant");
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(["book", "courses", "memberships", "vouchers", "help"] as const)(
    "preserves %s visibility through draft, preview, publish, reset and restore",
    async (page) => {
      const saved = await updateTenantPublicSiteDraft({
        tenantId,
        revision: 0,
        patch: { pages: { [page]: { visible: false } } },
      });
      expect(saved.draft.pages[page].visible).toBe(false);
      expect(saved.published.pages[page].visible).toBe(true);
      expect(
        serializeTenantPublicSite(tenant as never).pages[page].visible,
      ).toBe(true);
      const preview = await getTenantPublicSitePreview(tenantId);
      expect(preview.tenant.publicSite.pages[page].visible).toBe(false);

      const edited = await updateTenantPublicSiteDraft({
        tenantId,
        revision: saved.editor.draftRevision,
        patch: { pages: { [page]: { title: { en: "Hidden page title" } } } },
      });
      expect(edited.draft.pages[page].visible).toBe(false);
      const published = await publishTenantPublicSiteDraft({
        tenantId,
        userId: ownerId,
        revision: edited.editor.draftRevision,
      });
      expect(published.published.pages[page].visible).toBe(false);
      expect(
        serializeTenantPublicSite(tenant as never).pages[page].visible,
      ).toBe(false);
      expect(tenant.publicSite.pages[page].visible).toBe(false);
      expect(
        mocks.versionFindOneAndUpdate.mock.lastCall?.[1].$setOnInsert.snapshot
          .pages[page].visible,
      ).toBe(false);

      const shown = await updateTenantPublicSiteDraft({
        tenantId,
        revision: published.editor.draftRevision,
        patch: { pages: { [page]: { visible: true } } },
      });
      expect(shown.draft.pages[page].visible).toBe(true);
      const reset = await resetTenantPublicSiteDraft({
        tenantId,
        revision: shown.editor.draftRevision,
      });
      expect(reset.draft.pages[page].visible).toBe(false);

      const versionId = "507f1f77bcf86cd799439099";
      const versionQuery = {
        lean: vi.fn(),
        exec: vi.fn().mockResolvedValue({
          _id: versionId,
          snapshot: legacyPublicSite,
        }),
      };
      versionQuery.lean.mockReturnValue(versionQuery);
      mocks.versionFindOne.mockReturnValue(versionQuery);
      const restored = await restoreTenantPublicSiteVersion({
        tenantId,
        versionId,
        revision: reset.editor.draftRevision,
      });
      expect(restored.draft.pages[page].visible).toBe(true);
      expect(restored.published.pages[page].visible).toBe(false);

      versionQuery.exec.mockResolvedValue({
        _id: versionId,
        snapshot: published.published,
      });
      const restoredHidden = await restoreTenantPublicSiteVersion({
        tenantId,
        versionId,
        revision: restored.editor.draftRevision,
      });
      expect(restoredHidden.draft.pages[page].visible).toBe(false);
      expect(restoredHidden.draft.pages[page].title.en).toBe(
        "Hidden page title",
      );
    },
  );

  it("isolates all portal colors in the draft and preserves them through preview, publish, individual clearing and reset", async () => {
    const appearance = Object.fromEntries(
      PORTAL_APPEARANCE_COLOR_KEYS.map((key, index) => [
        key,
        `#AABB${index.toString(16).padStart(2, "0")}`.toUpperCase(),
      ]),
    );
    const inherited = Object.fromEntries(
      PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [key, ""]),
    );
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: { customerPortal: { appearance } },
    });
    expect(saved.draft.customerPortal.appearance).toEqual(appearance);
    expect(
      serializeTenantPublicSite(tenant as never).customerPortal.appearance,
    ).toEqual(inherited);
    const preview = await getTenantPublicSitePreview(tenantId);
    expect(preview.tenant.publicSite.customerPortal.appearance).toEqual(
      appearance,
    );
    const partial = await updateTenantPublicSiteDraft({
      tenantId,
      revision: saved.editor.draftRevision,
      patch: { customerPortal: { appearance: { backgroundColor: "" } } },
    });
    expect(partial.draft.customerPortal.appearance).toEqual({
      ...appearance,
      backgroundColor: "",
    });
    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: partial.editor.draftRevision,
    });
    expect(
      serializeTenantPublicSite(tenant as never).customerPortal.appearance,
    ).toEqual({ ...appearance, backgroundColor: "" });
    expect(
      mocks.versionFindOneAndUpdate.mock.lastCall?.[1].$setOnInsert.snapshot
        .customerPortal.appearance,
    ).toEqual({ ...appearance, backgroundColor: "" });
    const cleared = await updateTenantPublicSiteDraft({
      tenantId,
      revision: published.editor.draftRevision,
      patch: { customerPortal: { appearance: inherited } },
    });
    expect(cleared.draft.customerPortal.appearance).toEqual(inherited);
    const reset = await resetTenantPublicSiteDraft({
      tenantId,
      revision: cleared.editor.draftRevision,
    });
    expect(reset.draft.customerPortal.appearance).toEqual({
      ...appearance,
      backgroundColor: "",
    });
  });

  it("preserves all portal controls through draft edits, preview, publication, reset and version restore", async () => {
    const pages = Object.fromEntries(
      CUSTOMER_PORTAL_PAGE_IDS.map((page) => [page, { enabled: false }]),
    ) as TenantPublicSite["customerPortal"]["pages"];
    const navigation = Object.fromEntries(
      CUSTOMER_PORTAL_NAVIGATION_KEYS.map((item) => [item, { visible: false }]),
    ) as TenantPublicSite["customerPortal"]["navigation"];
    const disabled = { pages, navigation };
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: { customerPortal: disabled },
    });
    expect(saved.draft.customerPortal).toMatchObject(disabled);
    expect(saved.published.customerPortal.pages.calendar.enabled).toBe(true);
    expect(
      serializeTenantPublicSite(tenant as never).customerPortal.navigation
        .bookSession.visible,
    ).toBe(true);
    const preview = await getTenantPublicSitePreview(tenantId);
    expect(preview.tenant.publicSite.customerPortal).toMatchObject(disabled);

    const edited = await updateTenantPublicSiteDraft({
      tenantId,
      revision: saved.editor.draftRevision,
      patch: {
        customerPortal: {
          dashboard: { headline: { en: "Keep the portal controls" } },
        },
      },
    });
    expect(edited.draft.customerPortal).toMatchObject(disabled);
    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: edited.editor.draftRevision,
    });
    expect(published.published.customerPortal).toMatchObject(disabled);
    expect(tenant.publicSite.customerPortal).toMatchObject(disabled);
    expect(
      serializeTenantPublicSite(tenant as never).customerPortal,
    ).toMatchObject(disabled);
    expect(
      mocks.versionFindOneAndUpdate.mock.lastCall?.[1].$setOnInsert.snapshot
        .customerPortal,
    ).toMatchObject(disabled);
    expect(published.published.pages.book.visible).toBe(true);

    const partial = await updateTenantPublicSiteDraft({
      tenantId,
      revision: published.editor.draftRevision,
      patch: {
        customerPortal: {
          pages: { calendar: { enabled: true } },
          navigation: { bookSession: { visible: true } },
        },
      },
    });
    expect(partial.draft.customerPortal.pages.calendar.enabled).toBe(true);
    expect(partial.draft.customerPortal.navigation.bookSession.visible).toBe(
      true,
    );
    expect(partial.draft.customerPortal.pages.work.enabled).toBe(false);
    expect(partial.draft.customerPortal.navigation.memberships.visible).toBe(
      false,
    );
    const reset = await resetTenantPublicSiteDraft({
      tenantId,
      revision: partial.editor.draftRevision,
    });
    expect(reset.draft.customerPortal).toMatchObject(disabled);

    const versionId = "507f1f77bcf86cd799439099";
    const versionQuery = {
      lean: vi.fn(),
      exec: vi
        .fn()
        .mockResolvedValue({ _id: versionId, snapshot: legacyPublicSite }),
    };
    versionQuery.lean.mockReturnValue(versionQuery);
    mocks.versionFindOne.mockReturnValue(versionQuery);
    const restoredLegacy = await restoreTenantPublicSiteVersion({
      tenantId,
      versionId,
      revision: reset.editor.draftRevision,
    });
    expect(
      Object.values(restoredLegacy.draft.customerPortal.pages).every(
        (page) => page.enabled,
      ),
    ).toBe(true);
    expect(
      Object.values(restoredLegacy.draft.customerPortal.navigation).every(
        (item) => item.visible,
      ),
    ).toBe(true);
    expect(restoredLegacy.published.customerPortal).toMatchObject(disabled);

    versionQuery.exec.mockResolvedValue({
      _id: versionId,
      snapshot: published.published,
    });
    const restoredDisabled = await restoreTenantPublicSiteVersion({
      tenantId,
      versionId,
      revision: restoredLegacy.editor.draftRevision,
    });
    expect(restoredDisabled.draft.customerPortal).toMatchObject(disabled);
    expect(restoredDisabled.draft.customerPortal.dashboard.headline.en).toBe(
      "Keep the portal controls",
    );
  });

  it("keeps localized draft fields private, previews them, then atomically promotes the exact revision", async () => {
    const initial = await getTenantPublicSiteEditorState(tenantId);
    expect(initial.editor.draftRevision).toBe(0);
    expect(initial.draft.branding.displayName).toBe(
      "Published legacy identity",
    );
    expect(initial.draft.branding.stylePreset).toBe("classic-editorial-v1");

    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: initial.editor.draftRevision,
      patch: {
        branding: {
          displayName: "Unpublished identity",
          stylePreset: "modern-minimal-v1",
          fontPreset: "warm-serif-v1",
          labelColor: "#C45A42",
          description: {
            cs: "Soukromý český návrh",
            en: "Private English draft",
          },
        },
        login: {
          eyebrow: {
            en: "Private login label",
          },
          headline: {
            cs: "Soukromé přihlášení",
            en: "Private login",
          },
          labelColor: "#123ABC",
        },
        register: {
          eyebrow: {
            en: "Private registration label",
          },
          headline: {
            cs: "Soukromá registrace",
            en: "Private registration",
          },
          backgroundImageUrl:
            "https://media.shario.test/public-sites/tenant/registerBackground/private.webp",
          labelColor: "#ABCDEF",
        },
        pages: {
          home: {
            headline: {
              cs: "Soukromá domovská stránka",
              en: "Private home page",
            },
            labelColor: "#654321",
            headlineColor: "#abcdef",
          },
        },
        customerPortal: {
          appearance: {
            headerBackgroundColor: "#F4EFE8",
            primaryButtonColor: "#D27357",
            calendarBackgroundColor: "#FFFAF5",
            profileMenuBackgroundColor: "#F8F3ED",
          },
          dashboard: {
            eyebrow: { en: "Private portal label" },
            headline: { en: "Private customer dashboard" },
            description: { en: "Private portal description" },
            labelColor: "#FEDCBA",
          },
        },
      },
    });

    expect(saved.editor).toMatchObject({
      draftRevision: 1,
      publishedRevision: 0,
      hasUnpublishedChanges: true,
    });
    expect(saved.draft.branding.description).toEqual({
      en: "Private English draft",
      cs: "Soukromý český návrh",
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
    expect(saved.draft.branding.stylePreset).toBe("modern-minimal-v1");
    expect(saved.draft.branding.fontPreset).toBe("warm-serif-v1");
    expect(saved.draft.branding.labelColor).toBe("#C45A42");
    expect(saved.draft.pages.home.headlineColor).toBe("#ABCDEF");
    expect(saved.draft.register).toMatchObject({
      headline: {
        cs: "Soukromá registrace",
        en: "Private registration",
      },
      labelColor: "#ABCDEF",
    });
    expect(saved.draft.customerPortal.dashboard.headline.en).toBe(
      "Private customer dashboard",
    );
    expect(saved.draft.customerPortal.appearance).toEqual({
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
    expect(saved.draft.branding.accentColor).toBe("#1F36D4");

    const anonymousBeforePublish = serializeTenantPublicSite(tenant as never);
    expect(anonymousBeforePublish.branding.displayName).toBe(
      "Published legacy identity",
    );
    expect(JSON.stringify(anonymousBeforePublish)).not.toContain("Private");
    expect(JSON.stringify(anonymousBeforePublish)).not.toContain("Soukrom");
    expect(JSON.stringify(anonymousBeforePublish)).not.toContain(
      "Private registration",
    );
    expect(JSON.stringify(anonymousBeforePublish)).not.toContain(
      "Private customer dashboard",
    );
    expect(anonymousBeforePublish.branding.stylePreset).toBe(
      "classic-editorial-v1",
    );
    expect(anonymousBeforePublish.customerPortal.appearance).toEqual({
      backgroundColor: "",
      surfaceColor: "",
      textColor: "",
      headingColor: "",
      headerTextColor: "",
      calendarTextColor: "",
      headerBackgroundColor: "",
      primaryButtonColor: "",
      calendarBackgroundColor: "",
      profileMenuBackgroundColor: "",
    });
    expect(anonymousBeforePublish.pages.home.headlineColor).toBe("");

    const preview = await getTenantPublicSitePreview(tenantId);
    expect(preview.tenant.publicSite.branding.displayName).toBe(
      "Unpublished identity",
    );
    expect(preview.tenant.publicSite.pages.home.headline).toEqual({
      en: "Private home page",
      cs: "Soukromá domovská stránka",
      de: "Unpublished identity",
      pl: "Unpublished identity",
      sk: "Unpublished identity",
      da: "Unpublished identity",
      fr: "Unpublished identity",
      es: "Unpublished identity",
      it: "Unpublished identity",
      "pt-PT": "Unpublished identity",
      sv: "Unpublished identity",
      nb: "Unpublished identity",
      fi: "Unpublished identity",
      hu: "Unpublished identity",
      el: "Unpublished identity",
      tr: "Unpublished identity",
      nl: "Unpublished identity",
      ro: "Unpublished identity",
    });
    expect(preview.tenant.publicSite.pages.home.headlineColor).toBe("#ABCDEF");
    expect(preview.tenant.publicSite.branding.stylePreset).toBe(
      "modern-minimal-v1",
    );
    expect(preview.tenant.publicSite.branding.fontPreset).toBe("warm-serif-v1");
    expect(preview.tenant.publicSite.register.backgroundImageUrl).toContain(
      "/registerBackground/private.webp",
    );
    expect(preview.tenant.publicSite.customerPortal.dashboard).toMatchObject({
      eyebrow: { cs: "", en: "Private portal label" },
      headline: { cs: "", en: "Private customer dashboard" },
      description: { cs: "", en: "Private portal description" },
      labelColor: "#FEDCBA",
    });
    expect(preview.tenant.publicSite.customerPortal.appearance).toEqual({
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
    expect(mocks.buildPublicTenantConfig).toHaveBeenCalledWith(tenant, {
      snapshot: "draft",
    });

    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: saved.editor.draftRevision,
    });

    expect(published.editor).toMatchObject({
      draftRevision: 1,
      publishedRevision: 1,
      hasUnpublishedChanges: false,
    });
    expect(published.published).toEqual(saved.draft);
    expect(published.published.pages.home.headlineColor).toBe("#ABCDEF");
    expect(tenant.publicSite).toEqual(saved.draft);
    expect(tenant.publicSiteEditor.publishedBy).toBe(ownerId);
    expect(serializeTenantPublicSite(tenant as never)).toEqual(saved.draft);
    expect(tenant.publicSite.branding.stylePreset).toBe("modern-minimal-v1");
    expect(tenant.publicSite.branding.fontPreset).toBe("warm-serif-v1");
    expect(tenant.publicSite.register.headline.en).toBe("Private registration");
    expect(tenant.publicSite.pages.home.headlineColor).toBe("#ABCDEF");
    expect(tenant.publicSite.customerPortal.dashboard.headline.en).toBe(
      "Private customer dashboard",
    );
    expect(tenant.publicSite.customerPortal.appearance).toEqual({
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
    expect(mocks.startSession).toHaveBeenCalledOnce();
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.endSession).toHaveBeenCalledOnce();
    expect(mocks.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: tenantId,
        "publicSiteEditor.draftRevision": 1,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "publicSiteEditor.publishedRevision": 1,
        }),
      }),
      expect.objectContaining({
        returnDocument: "after",
        runValidators: true,
        session: expect.objectContaining({
          withTransaction: mocks.withTransaction,
        }),
      }),
    );
    expect(mocks.versionFindOneAndUpdate).toHaveBeenLastCalledWith(
      { tenant: tenantId, sourceDraftRevision: 1 },
      {
        $setOnInsert: expect.objectContaining({
          snapshot: published.published,
          publishedBy: ownerId,
        }),
      },
      expect.objectContaining({
        upsert: true,
        runValidators: true,
        session: expect.objectContaining({
          withTransaction: mocks.withTransaction,
        }),
      }),
    );
    expect(mocks.cleanupDiscardedPublicSiteMedia).toHaveBeenLastCalledWith({
      tenantId,
      beforeDraft: initial.published,
      afterDraft: published.draft,
      published: published.published,
    });
  });

  it("keeps a style-only draft private until its exact revision is published", async () => {
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: {
        branding: { stylePreset: "modern-minimal-v1" },
      },
    });

    expect(saved.draft.branding).toMatchObject({
      stylePreset: "modern-minimal-v1",
      displayName: "Published legacy identity",
      accentColor: "#1F36D4",
      secondaryColor: "#D27357",
    });
    expect(saved.published.branding.stylePreset).toBe("classic-editorial-v1");
    expect(
      serializeTenantPublicSite(tenant as never).branding.stylePreset,
    ).toBe("classic-editorial-v1");

    const preview = await getTenantPublicSitePreview(tenantId);
    expect(preview.tenant.publicSite.branding.stylePreset).toBe(
      "modern-minimal-v1",
    );

    const published = await publishTenantPublicSiteDraft({
      tenantId,
      userId: ownerId,
      revision: saved.editor.draftRevision,
    });

    expect(published.published).toEqual(saved.draft);
    expect(published.editor.hasUnpublishedChanges).toBe(false);
    expect(tenant.publicSite).toEqual(saved.draft);
    expect(
      serializeTenantPublicSite(tenant as never).branding.stylePreset,
    ).toBe("modern-minimal-v1");
  });

  it("rejects a stale revision without overwriting the winning draft", async () => {
    const winner = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: {
        branding: { displayName: "Winning draft" },
      },
    });
    expect(winner.editor.draftRevision).toBe(1);

    await expect(
      updateTenantPublicSiteDraft({
        tenantId,
        revision: 0,
        patch: {
          branding: { displayName: "Stale overwrite" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLIC_SITE_REVISION_CONFLICT",
    });
    expect(
      serializeTenantPublicSite(tenant as never, {
        snapshot: "draft",
      }).branding.displayName,
    ).toBe("Winning draft");
  });

  it("lists bounded version metadata without loading stored snapshots", async () => {
    const publishedAt = new Date("2026-08-24T10:15:00.000Z");
    const exec = vi.fn().mockResolvedValue([
      {
        _id: "507f1f77bcf86cd799439099",
        sourceDraftRevision: 7,
        publishedAt,
        publishedBy: ownerId,
        restoredFromVersion: "507f1f77bcf86cd799439098",
      },
    ]);
    const query = {
      sort: vi.fn(),
      limit: vi.fn(),
      select: vi.fn(),
      lean: vi.fn(),
      exec,
    };
    query.sort.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.select.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    mocks.versionFind.mockReturnValue(query);

    await expect(listTenantPublicSiteVersions(tenantId)).resolves.toEqual({
      versions: [
        {
          id: "507f1f77bcf86cd799439099",
          sourceDraftRevision: 7,
          publishedAt: "2026-08-24T10:15:00.000Z",
          publishedBy: ownerId,
          restoredFromVersion: "507f1f77bcf86cd799439098",
        },
      ],
    });

    expect(mocks.versionFind).toHaveBeenCalledWith({ tenant: tenantId });
    expect(query.sort).toHaveBeenCalledWith({ publishedAt: -1, _id: -1 });
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(query.select).toHaveBeenCalledWith(
      "_id sourceDraftRevision publishedAt publishedBy restoredFromVersion",
    );
    expect(query.lean).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("restores a version into the draft through revision compare-and-swap", async () => {
    const versionId = "507f1f77bcf86cd799439099";
    const currentDraft = structuredClone(legacyPublicSite);
    currentDraft.branding.displayName = "Current private draft";
    tenant.publicSiteEditor = {
      draft: currentDraft,
      draftRevision: 3,
      published: structuredClone(legacyPublicSite),
      publishedRevision: 2,
    };
    const versionSnapshot = structuredClone(legacyPublicSite);
    versionSnapshot.branding.displayName = "Restored historical site";
    const version = {
      _id: versionId,
      snapshot: versionSnapshot,
    };
    const versionExec = vi.fn().mockResolvedValue(version);
    const versionQuery = {
      lean: vi.fn(),
      exec: versionExec,
    };
    versionQuery.lean.mockReturnValue(versionQuery);
    mocks.versionFindOne.mockReturnValue(versionQuery);

    const restored = await restoreTenantPublicSiteVersion({
      tenantId,
      versionId,
      revision: 3,
    });

    expect(mocks.versionFindOne).toHaveBeenCalledWith({
      _id: versionId,
      tenant: tenantId,
    });
    expect(mocks.findOneAndUpdate).toHaveBeenLastCalledWith(
      {
        _id: tenantId,
        "publicSiteEditor.draftRevision": 3,
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          "publicSiteEditor.draft": expect.objectContaining({
            branding: expect.objectContaining({
              displayName: "Restored historical site",
            }),
          }),
          "publicSiteEditor.draftRestoredFromVersion": versionId,
        }),
        $inc: { "publicSiteEditor.draftRevision": 1 },
      }),
      { returnDocument: "after", runValidators: true },
    );
    expect(restored.editor).toMatchObject({
      draftRevision: 4,
      publishedRevision: 2,
      hasUnpublishedChanges: true,
    });
    expect(restored.draft.branding.displayName).toBe(
      "Restored historical site",
    );
    expect(tenant.publicSite.branding.displayName).toBe(
      "Published legacy identity",
    );
    expect(mocks.cleanupDiscardedPublicSiteMedia).toHaveBeenLastCalledWith({
      tenantId,
      beforeDraft: expect.objectContaining({
        branding: expect.objectContaining({
          displayName: "Current private draft",
        }),
      }),
      afterDraft: restored.draft,
      published: restored.published,
    });

    await expect(
      restoreTenantPublicSiteVersion({
        tenantId,
        versionId,
        revision: 3,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLIC_SITE_REVISION_CONFLICT",
    });
    expect(mocks.versionFindOne).toHaveBeenCalledOnce();
  });

  it("keeps the generated home headline in sync while preserving optional login copy", async () => {
    tenant.publicSite.branding.displayName = "";
    tenant.publicSite.login.headline = { cs: "", en: "" };
    tenant.publicSite.pages.home.headline = { cs: "", en: "" };

    const result = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: {
        branding: { displayName: "Olivka Creative Studio" },
        login: {
          headline: {
            cs: "Vlastní české přihlášení",
          },
        },
      },
    });

    expect(result.draft.pages.home.headline).toEqual({
      en: "Olivka Creative Studio",
      cs: "Olivka Creative Studio",
      de: "Olivka Creative Studio",
      pl: "Olivka Creative Studio",
      sk: "Olivka Creative Studio",
      da: "Olivka Creative Studio",
      fr: "Olivka Creative Studio",
      es: "Olivka Creative Studio",
      it: "Olivka Creative Studio",
      "pt-PT": "Olivka Creative Studio",
      sv: "Olivka Creative Studio",
      nb: "Olivka Creative Studio",
      fi: "Olivka Creative Studio",
      hu: "Olivka Creative Studio",
      el: "Olivka Creative Studio",
      tr: "Olivka Creative Studio",
      nl: "Olivka Creative Studio",
      ro: "Olivka Creative Studio",
    });
    expect(result.draft.login.headline).toEqual({
      en: "",
      cs: "Vlastní české přihlášení",
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
  });

  it("turns a compare-and-swap race into a conflict", async () => {
    mocks.findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValueOnce(null),
    });

    await expect(
      updateTenantPublicSiteDraft({
        tenantId,
        revision: 0,
        patch: {
          branding: { displayName: "Lost concurrent write" },
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLIC_SITE_REVISION_CONFLICT",
    });
    expect(tenant.publicSite.branding.displayName).toBe(
      "Published legacy identity",
    );
  });

  it("resets only the draft to the published snapshot and advances its revision", async () => {
    const saved = await updateTenantPublicSiteDraft({
      tenantId,
      revision: 0,
      patch: {
        branding: { displayName: "Temporary draft" },
      },
    });
    expect(saved.editor.draftRevision).toBe(1);
    expect(mocks.deleteCache).not.toHaveBeenCalled();

    const reset = await resetTenantPublicSiteDraft({
      tenantId,
      revision: 1,
    });

    expect(reset.editor).toMatchObject({
      draftRevision: 2,
      publishedRevision: 0,
      hasUnpublishedChanges: false,
    });
    expect(reset.draft.branding.displayName).toBe("Published legacy identity");
    expect(tenant.publicSite.branding.displayName).toBe(
      "Published legacy identity",
    );
    expect(mocks.deleteCache).not.toHaveBeenCalled();
  });
});
