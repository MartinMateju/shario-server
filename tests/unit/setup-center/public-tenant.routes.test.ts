import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  publicationExists: vi.fn(),
  getOrSetCache: vi.fn(),
  hydrate: vi.fn(),
  derivePublicTenantCapabilities: vi.fn(),
  locations: vi.fn(),
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    find: () => ({
      select: () => ({ lean: () => ({ exec: mocks.locations }) }),
    }),
  },
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));
vi.mock("@/modules/setup-center/setup-center.model.js", () => ({
  SetupCenterStateModel: { exists: mocks.publicationExists },
}));
vi.mock("@/infrastructure/redis/cache.js", () => ({
  getOrSetCache: mocks.getOrSetCache,
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { hydrate: mocks.hydrate },
}));
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.capabilities.js",
  () => ({
    derivePublicTenantCapabilities: mocks.derivePublicTenantCapabilities,
  }),
);

import { publicTenantRouter } from "@/modules/tenants/public-tenant.routes.js";
import { findPublishedTenantBySlug } from "@/modules/setup-center/setup-publication.service.js";

const app = express();
app.use(publicTenantRouter);

const liveTenant = {
  _id: "507f1f77bcf86cd799439011",
  name: "Studio Grohovka",
  slug: "studio-grohovka",
  status: "active",
  settings: {
    defaultLanguage: "CZ",
    currency: "CZK",
    timezone: "Europe/Prague",
  },
  modules: {
    bookings: true,
    payments: true,
    memberships: true,
    vouchers: true,
  },
};

const tenantDocument = (value: Record<string, unknown>) => ({
  ...value,
  toObject: () => structuredClone(value),
});

describe("public tenant configuration", () => {
  let publicationStatus: "live" | "draft" | null;

  it.each([
    ["time", false],
    ["piece", false],
    ["both", false],
    [undefined, false],
  ])(
    "exposes customer My work capability for %s without exposing intent answers",
    async (pricingMode, enabled) => {
      mocks.getTenantBySlug.mockResolvedValueOnce(
        tenantDocument({
          ...liveTenant,
          modules: { ...liveTenant.modules, firing: true },
          workspaceIntent: { pricingMode, answers: { inventory: true } },
        }),
      );
      const response = await request(app)
        .get("/tenants/studio-grohovka/config")
        .expect(200);
      expect(response.body.tenant.customerCapabilities).toEqual({
        myWork: enabled,
      });
      expect(response.body.tenant).not.toHaveProperty("workspaceIntent");
      expect(response.body.tenant).not.toHaveProperty("modules");
    },
  );
  beforeEach(() => {
    vi.clearAllMocks();
    publicationStatus = "live";
    mocks.getTenantBySlug
      .mockReset()
      .mockResolvedValue(tenantDocument(liveTenant));
    mocks.publicationExists.mockImplementation(async (filter) => {
      expect(filter).toEqual({
        tenant: liveTenant._id,
        "publication.status": "live",
      });
      return publicationStatus === "live" ? { _id: "live-publication" } : null;
    });
    mocks.getOrSetCache.mockImplementation(
      async (_key: string, _ttl: number, resolve: () => Promise<unknown>) =>
        resolve(),
    );
    mocks.hydrate.mockImplementation((value) => value);
    mocks.locations.mockResolvedValue([{ pricingMode: null }]);
    mocks.derivePublicTenantCapabilities.mockResolvedValue({
      bookStudio: true,
      courses: false,
      memberships: true,
      vouchers: true,
      help: false,
      guestCourseCheckout: false,
      registration: true,
    });
  });

  it("keeps root My work reachable for a piece studio under a time workspace", async () => {
    mocks.getTenantBySlug.mockResolvedValueOnce(
      tenantDocument({
        ...liveTenant,
        modules: { ...liveTenant.modules, firing: true },
        workspaceIntent: { pricingMode: "time" },
      }),
    );
    mocks.locations.mockResolvedValueOnce([
      { pricingMode: "time" },
      { pricingMode: "piece" },
    ]);
    const response = await request(app)
      .get("/tenants/studio-grohovka/config")
      .expect(200);
    expect(response.body.tenant.customerCapabilities).toEqual({ myWork: false });
  });

  it("returns only public workspace configuration for a live tenant", async () => {
    const response = await request(app)
      .get("/tenants/studio-grohovka/config")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.body.tenant).toMatchObject({
      id: "507f1f77bcf86cd799439011",
      name: "Studio Grohovka",
      slug: "studio-grohovka",
      settings: {
        defaultLanguage: "CZ",
        currency: "CZK",
        timezone: "Europe/Prague",
      },
      publicSite: {
        branding: {
          displayName: "Studio Grohovka",
          stylePreset: "classic-editorial-v1",
          accentColor: "#1F36D4",
        },
        login: {
          headline: {
            cs: "",
            en: "",
          },
        },
        header: {
          navOrder: ["book", "courses", "memberships", "vouchers", "help"],
          hiddenItems: [],
          primaryCta: "auto",
        },
      },
      publicCapabilities: {
        bookStudio: true,
        courses: false,
        memberships: true,
        vouchers: true,
        help: false,
        guestCourseCheckout: false,
        registration: true,
      },
    });
    expect(response.body.tenant).not.toHaveProperty("modules");
    expect(response.body.tenant).not.toHaveProperty("limits");
    expect(response.body.tenant).not.toHaveProperty("plan");
    expect(response.body.tenant).not.toHaveProperty("domains");
    expect(response.body.tenant).not.toHaveProperty("onboarding");
  });

  it("reads the freshly published favicon even when the default lookup still has a stale cached tenant", async () => {
    const oldFavicon = "https://media.example.test/favicon/old.png";
    const newFavicon = "https://media.example.test/favicon/new.png";
    const cachedTenant = {
      ...liveTenant,
      publicSiteEditor: {
        published: { branding: { faviconUrl: oldFavicon } },
        publishedRevision: 1,
      },
    };
    mocks.getOrSetCache.mockResolvedValue(cachedTenant);
    mocks.getTenantBySlug.mockResolvedValue(
      tenantDocument({
        ...liveTenant,
        publicSiteEditor: {
          published: { branding: { faviconUrl: newFavicon } },
          publishedRevision: 2,
        },
      }),
    );

    const cached = await findPublishedTenantBySlug(" Studio-Grohovka ");
    expect(cached?.publicSiteEditor?.published?.branding.faviconUrl).toBe(
      oldFavicon,
    );
    expect(mocks.getOrSetCache).toHaveBeenCalledWith(
      "shario:public-tenant:studio-grohovka",
      expect.any(Number),
      expect.any(Function),
    );
    expect(mocks.getTenantBySlug).not.toHaveBeenCalled();
    expect(mocks.publicationExists).not.toHaveBeenCalled();
    mocks.getOrSetCache.mockClear();
    mocks.hydrate.mockClear();

    const response = await request(app)
      .get("/tenants/studio-grohovka/config")
      .expect(200);

    expect(response.body.tenant.publicSite.branding.faviconUrl).toBe(
      newFavicon,
    );
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(mocks.getTenantBySlug).toHaveBeenCalledExactlyOnceWith(
      "studio-grohovka",
    );
    expect(mocks.publicationExists).toHaveBeenCalledOnce();
    expect(mocks.getOrSetCache).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "inactive",
    "draft",
    "missing publication state",
  ] as const)(
    "returns the same uncached 404 for a %s workspace despite a cached live tenant",
    async (state) => {
      mocks.getOrSetCache.mockResolvedValue(liveTenant);
      if (state === "missing") {
        mocks.getTenantBySlug.mockResolvedValue(null);
      } else if (state === "inactive") {
        mocks.getTenantBySlug.mockResolvedValue(
          tenantDocument({
            ...liveTenant,
            status: "inactive",
          }),
        );
      } else {
        publicationStatus = state === "draft" ? "draft" : null;
      }

      const response = await request(app)
        .get("/tenants/studio-grohovka/config")
        .expect(404);

      expect(response.body).toEqual({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
      expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
      expect(mocks.getTenantBySlug).toHaveBeenCalledExactlyOnceWith(
        "studio-grohovka",
      );
      expect(mocks.getOrSetCache).not.toHaveBeenCalled();
      expect(mocks.hydrate).not.toHaveBeenCalled();
      expect(mocks.derivePublicTenantCapabilities).not.toHaveBeenCalled();
    },
  );
});
