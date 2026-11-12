import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  assertCurrencyCanChange: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/modules/tenants/services/tenant-currency.service.js", () => ({
  assertTenantOperationalCurrencyCanChange: mocks.assertCurrencyCanChange,
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

import {
  getTenantWorkspaceSettings,
  updateTenantWorkspaceSettings,
} from "@/modules/tenants/settings/tenant-settings.service.js";
import { updateTenantSettingsSchema } from "@/modules/tenants/settings/tenant-settings.validators.js";

const makeTenant = () => {
  const tenant: any = {
    _id: "507f1f77bcf86cd799439011",
    name: "Legacy studio",
    slug: "legacy-studio",
    onboarding: {
      completed: true,
      businessDetails: {},
    },
    status: "active",
    plan: "professional",
    planVersion: 1,
    settings: {
      defaultLanguage: "EN",
      currency: "CZK",
      timezone: "Europe/Prague",
      navigation: { hiddenGroups: [], hiddenItems: [] },
    },
    domains: [],
    modules: {},
    limits: {},
    updatedAt: new Date("2026-08-05T09:00:00.000Z"),
    save: vi.fn().mockResolvedValue(undefined),
    set: vi.fn((path: string, value: unknown) => {
      if (path === "onboarding.businessType") {
        tenant.onboarding.businessType = value;
      }
      if (path === "onboarding.businessDetails.country") {
        tenant.onboarding.businessDetails.country = value;
      }
    }),
  };
  return tenant;
};

describe("tenant settings launch-profile repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts only canonical business profile fields", () => {
    expect(
      updateTenantSettingsSchema.parse({
        businessType: "coworking_space",
        country: "  CZ  ",
      }),
    ).toEqual({ businessType: "coworking_space", country: "CZ" });

    expect(
      updateTenantSettingsSchema.safeParse({
        businessType: "restaurant",
        country: "CZ",
      }).success,
    ).toBe(false);
    expect(
      updateTenantSettingsSchema.safeParse({
        businessType: "coworking_space",
        country: "",
      }).success,
    ).toBe(false);
    expect(
      updateTenantSettingsSchema.safeParse({ completed: true }).success,
    ).toBe(false);
  });

  it("returns and persists missing completed-tenant profile details", async () => {
    const tenant = makeTenant();
    mocks.getTenantOrThrow.mockResolvedValue(tenant);

    await expect(
      getTenantWorkspaceSettings(String(tenant._id)),
    ).resolves.toMatchObject({
      businessType: null,
      country: "",
    });

    const result = await updateTenantWorkspaceSettings({
      tenantId: String(tenant._id),
      input: updateTenantSettingsSchema.parse({
        businessType: "coworking_space",
        country: "CZ",
      }),
    });

    expect(tenant.set).toHaveBeenCalledWith(
      "onboarding.businessType",
      "coworking_space",
    );
    expect(tenant.set).toHaveBeenCalledWith(
      "onboarding.businessDetails.country",
      "CZ",
    );
    expect(tenant.save).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      businessType: "coworking_space",
      country: "CZ",
    });
    expect(tenant.onboarding.completed).toBe(true);
  });
});
