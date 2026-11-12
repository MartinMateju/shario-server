import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/modules/tenants/services/tenant-currency.service.js", () => ({
  assertTenantOperationalCurrencyCanChange: vi.fn(),
}));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  getTenantPublicationState: vi.fn(),
}));
vi.mock("@/modules/setup-center/setup-center.model.js", () => ({
  SetupAuditEventModel: { create: vi.fn() },
}));
vi.mock("@/modules/tenants/tenant-workspace-modules.js", () => ({
  deriveEffectiveTenantModules: vi.fn(),
  getLegacyWorkspaceModuleSelection: vi.fn(),
  getTenantModuleEntitlements: vi.fn(),
  materializeWorkspaceModuleSelections: vi.fn(),
  setWorkspaceModuleSelection: vi.fn(),
}));
vi.mock("@/modules/tenants/public-site/tenant-public-site.config.js", () => ({
  buildPublicTenantConfig: vi.fn(),
}));
vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.serializers.js",
  () => ({ serializeTenantPublicSite: vi.fn() }),
);
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findOneAndUpdate: vi.fn() },
}));
vi.mock("@/modules/tenants/settings/public-site-media-cleanup.js", () => ({
  cleanupDiscardedPublicSiteMedia: vi.fn(),
}));

import { updateTenantWorkspaceSettings } from "@/modules/tenants/settings/tenant-settings.service.js";
import { updateTenantSettingsSchema } from "@/modules/tenants/settings/tenant-settings.validators.js";

const makeTenant = () => ({
  _id: "507f1f77bcf86cd799439011",
  name: "Locale studio",
  slug: "locale-studio",
  onboarding: { businessDetails: {} },
  status: "active",
  plan: "professional",
  planVersion: 1,
  settings: {
    defaultLanguage: "EN",
    adminLanguage: "en",
    publicDefaultLanguage: "en",
    supportedPublicLanguages: ["en", "de"],
    currency: "EUR",
    timezone: "Europe/Prague",
    navigation: { hiddenGroups: [], hiddenItems: [] },
  },
  domains: [],
  modules: {},
  limits: {},
  updatedAt: new Date("2026-08-14T20:00:00.000Z"),
  save: vi.fn().mockResolvedValue(undefined),
  set: vi.fn(),
});

describe("tenant public-language settings service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the primary first and one explicit secondary", async () => {
    const tenant = makeTenant();
    mocks.getTenantOrThrow.mockResolvedValue(tenant);

    await updateTenantWorkspaceSettings({
      tenantId: String(tenant._id),
      input: updateTenantSettingsSchema.parse({
        publicDefaultLanguage: "pl-PL",
        supportedPublicLanguages: ["de-DE"],
      }),
    });

    expect(tenant.settings.publicDefaultLanguage).toBe("pl");
    expect(tenant.settings.supportedPublicLanguages).toEqual(["pl", "de"]);
    expect(tenant.save).toHaveBeenCalledOnce();
  });

  it("keeps one prior language when only the primary changes", async () => {
    const tenant = makeTenant();
    mocks.getTenantOrThrow.mockResolvedValue(tenant);

    await updateTenantWorkspaceSettings({
      tenantId: String(tenant._id),
      input: updateTenantSettingsSchema.parse({
        publicDefaultLanguage: "pl",
      }),
    });

    expect(tenant.settings.supportedPublicLanguages).toEqual(["pl", "en"]);
  });

  it("rejects an explicit selection that would add a third language", async () => {
    const tenant = makeTenant();
    mocks.getTenantOrThrow.mockResolvedValue(tenant);

    await expect(
      updateTenantWorkspaceSettings({
        tenantId: String(tenant._id),
        input: updateTenantSettingsSchema.parse({
          supportedPublicLanguages: ["de", "pl"],
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "TENANT_PUBLIC_LANGUAGE_LIMIT_EXCEEDED",
    });
    expect(tenant.save).not.toHaveBeenCalled();
  });
});
