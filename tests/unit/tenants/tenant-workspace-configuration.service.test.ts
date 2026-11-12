import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantOrThrow: vi.fn(),
  assertCurrency: vi.fn(),
  setupAuditCreate: vi.fn(),
  cacheDelete: vi.fn(),
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.getTenantOrThrow,
}));
vi.mock("@/modules/tenants/services/tenant-currency.service.js", () => ({
  assertTenantOperationalCurrencyCanChange: mocks.assertCurrency,
}));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  getTenantPublicationState: vi.fn(),
  publicTenantCacheKey: (slug: string) => `shario:public-tenant:${slug}`,
}));
vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: mocks.cacheDelete,
}));
vi.mock("@/modules/setup-center/setup-center.model.js", () => ({
  SetupAuditEventModel: { create: mocks.setupAuditCreate },
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
  TENANT_PLAN,
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_SOURCE,
} from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import { reconcileTenantPlanModules } from "@/modules/tenants/tenant-workspace-modules.js";
import { deriveCustomerTenantCapabilities } from "@/modules/tenants/tenant-customer-capabilities.js";
import {
  getTenantWorkspaceConfiguration,
  getTenantWorkspaceSettings,
  updateTenantWorkspaceConfiguration,
} from "@/modules/tenants/settings/tenant-settings.service.js";

describe("tenant workspace configuration service", () => {
  const ACTOR_ID = "507f1f77bcf86cd799439012";
  const save = vi.fn();
  const deleteOne = vi.fn();
  const archive = vi.fn();
  let tenant: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const starter = getPlanConfig(TENANT_PLAN.STARTER);
    tenant = {
      _id: "507f1f77bcf86cd799439011",
      slug: "studio-a",
      plan: TENANT_PLAN.STARTER,
      planVersion: starter.version,
      modules: { ...starter.modules },
      workspaceModules: {},
      settings: {
        defaultLanguage: "EN",
        currency: "EUR",
        timezone: "Europe/Prague",
        navigation: { hiddenGroups: [], hiddenItems: [] },
      },
      domains: [{ hostname: "studio.example" }],
      save,
      deleteOne,
      archive,
    };
    save.mockResolvedValue(undefined);
    mocks.getTenantOrThrow.mockResolvedValue(tenant);
    mocks.setupAuditCreate.mockResolvedValue({ _id: "audit-1" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns complete effective flags and selected-by-default future modules", async () => {
    const result = await getTenantWorkspaceConfiguration("tenant-1");
    expect(Object.keys(result.effectiveModules)).toHaveLength(15);
    expect(result.modules.firing).toMatchObject({
      entitled: false,
      selected: false,
      enabled: false,
    });
    expect(result.modules.access_codes).toMatchObject({
      entitled: false,
      selected: true,
      enabled: false,
    });
    expect(result.intent).toEqual({
      configured: false,
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      answers: null,
      pricingMode: null,
      source: null,
      confirmedAt: null,
      updatedAt: null,
    });
  });

  it("changes customer My work through the pricing answer while preserving module flags", async () => {
    const originalModules = structuredClone(tenant.modules);
    for (const [pricingMode, enabled] of [
      ["time", false],
      ["time", false],
      ["time", false],
      ["time", false],
    ] as const) {
      const result = await updateTenantWorkspaceConfiguration({
        tenantId: "tenant-1",
        actorUserId: ACTOR_ID,
        input: {
          intent: {
            definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
            pricingMode,
          },
        },
      });
      expect(result.intent.pricingMode).toBe(pricingMode);
      expect(deriveCustomerTenantCapabilities(tenant)).toEqual({
        myWork: enabled,
      });
      expect(tenant.modules).toEqual(originalModules);
      expect(mocks.cacheDelete).toHaveBeenLastCalledWith(
        "shario:public-tenant:studio-a",
      );
    }
    expect(save).toHaveBeenCalledTimes(4);
    expect(mocks.cacheDelete).toHaveBeenCalledTimes(4);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cacheDelete.mock.invocationCallOrder[0],
    );
    expect(deleteOne).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("does not publish a failed questionnaire save to the cache", async () => {
    save.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      updateTenantWorkspaceConfiguration({
        tenantId: "tenant-1",
        actorUserId: ACTOR_ID,
        input: { intent: { pricingMode: "time" } },
      }),
    ).rejects.toThrow("write failed");
    expect(mocks.cacheDelete).not.toHaveBeenCalled();
    expect(mocks.setupAuditCreate).not.toHaveBeenCalled();
  });

  it("serializes effective Access Codes flags for legacy and V3 workspaces", async () => {
    const legacy = getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2);
    tenant.plan = TENANT_PLAN.PROFESSIONAL;
    tenant.planVersion = 2;
    tenant.modules = { ...legacy.modules };
    tenant.workspaceModules = {};

    expect(
      (await getTenantWorkspaceSettings("tenant-1")).modules.access_codes,
    ).toBe(true);

    tenant.workspaceModules = { access_codes: { selected: false } };
    expect(
      (await getTenantWorkspaceSettings("tenant-1")).modules.access_codes,
    ).toBe(false);

    const starter = getPlanConfig(TENANT_PLAN.STARTER, 3);
    tenant.plan = TENANT_PLAN.STARTER;
    tenant.planVersion = 3;
    tenant.modules = { ...starter.modules };
    tenant.workspaceModules = {};
    expect(
      (await getTenantWorkspaceSettings("tenant-1")).modules.access_codes,
    ).toBe(false);
  });

  it("persists opt-outs and navigation without touching domain data", async () => {
    const domains = tenant.domains;
    const result = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        modules: { bookings: false },
        navigation: {
          hiddenGroups: ["bookings"],
          hiddenItems: ["reports"],
        },
      },
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(tenant.domains).toBe(domains);
    expect(tenant.modules.bookings).toBe(false);
    expect(result.modules.bookings).toMatchObject({
      entitled: true,
      selected: false,
      enabled: false,
      disabledAt: expect.any(Date),
    });
    expect(result.navigation).toEqual({
      hiddenGroups: ["bookings"],
      hiddenItems: ["reports"],
    });

    const disabledAt = result.modules.bookings.disabledAt;
    const replay = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: { modules: { bookings: false } },
    });
    expect(replay.modules.bookings.disabledAt).toBe(disabledAt);
    expect(save).toHaveBeenCalledTimes(2);
    expect(deleteOne).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("confirms legacy intent without applying its derived module map", async () => {
    const modules = {
      bookings: true,
      payments: true,
      customers: true,
      courses: false,
      memberships: false,
      credits: false,
      vouchers: false,
      access_codes: false,
      automations: false,
      newsletter: false,
      firing: false as const,
      inventory: false,
      staff_tasks: false,
      communications: false,
      ai: false,
    };

    const result = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: 1,
          modules,
        },
      },
    });

    expect(tenant.workspaceIntent).toMatchObject({
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
      confirmedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(tenant.modules.firing).toBe(false);
    expect(result.intent).toMatchObject({
      configured: true,
      source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
    });
    expect(mocks.setupAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: "tenant-1",
        actor: ACTOR_ID,
        event: "workspace_intent_confirmed",
        metadata: expect.objectContaining({
          changedModules: [],
        }),
      }),
    );

    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL);
    reconcileTenantPlanModules(
      tenant,
      TENANT_PLAN.PROFESSIONAL,
      professional.version,
    );
    expect(tenant.workspaceModules.firing?.selected ?? false).toBe(false);
    expect(tenant.modules.firing).toBe(false);

    const originalUpdatedAt = tenant.workspaceIntent.updatedAt;
    mocks.setupAuditCreate.mockClear();
    await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: 1,
          modules,
        },
      },
    });

    expect(tenant.workspaceIntent.updatedAt).toBe(originalUpdatedAt);
    expect(mocks.setupAuditCreate).not.toHaveBeenCalled();
  });

  it("tracks later module changes as updates to a confirmed intent", async () => {
    const confirmedAt = new Date("2026-08-01T12:00:00.000Z");
    tenant.workspaceIntent = {
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      confirmedAt,
      updatedAt: confirmedAt,
      source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
    };

    await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: { modules: { bookings: false } },
    });

    expect(tenant.workspaceIntent.confirmedAt).toBe(confirmedAt);
    expect(tenant.workspaceIntent.updatedAt).not.toBe(confirmedAt);
    expect(mocks.setupAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_intent_updated",
        metadata: expect.objectContaining({ changedModules: ["bookings"] }),
      }),
    );
  });

  it("persists exact answers and audits answer-only questionnaire reruns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    const modules = {
      bookings: true,
      payments: true,
      customers: true,
      courses: true,
      memberships: false,
      credits: false,
      vouchers: false,
      access_codes: false,
      automations: false,
      newsletter: false,
      firing: false as const,
      inventory: false,
      staff_tasks: false,
      communications: true,
      ai: false,
    };
    const answers = {
      sharedStudio: true,
      classes: true,
      firingServices: false as const,
      memberships: false,
      vouchers: false,
      inventory: false,
    };

    const confirmed = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules,
          answers,
        },
      },
    });

    expect(tenant.workspaceIntent.answers).toEqual(answers);
    expect(confirmed.intent.answers).toEqual(answers);

    const confirmedAt = tenant.workspaceIntent.confirmedAt;
    const originalUpdatedAt = tenant.workspaceIntent.updatedAt;
    mocks.setupAuditCreate.mockClear();
    // Both workflows select the same core modules. Turning off shared-studio
    // therefore changes the exact answer set without changing the module map.
    const changedAnswers = { ...answers, sharedStudio: false };
    vi.setSystemTime(new Date("2026-08-30T12:01:00.000Z"));

    const updated = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules,
          answers: changedAnswers,
        },
      },
    });

    expect(tenant.workspaceIntent.confirmedAt).toBe(confirmedAt);
    expect(tenant.workspaceIntent.updatedAt).toEqual(
      new Date("2026-08-30T12:01:00.000Z"),
    );
    expect(tenant.workspaceIntent.updatedAt).not.toEqual(originalUpdatedAt);
    expect(updated.intent.answers).toEqual(changedAnswers);
    expect(mocks.setupAuditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.setupAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "workspace_intent_updated",
        metadata: expect.objectContaining({
          changedModules: [],
          changedAnswers: ["sharedStudio"],
          answers: changedAnswers,
        }),
      }),
    );

    const rerunUpdatedAt = tenant.workspaceIntent.updatedAt;
    mocks.setupAuditCreate.mockClear();
    await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: 1,
          modules,
        },
      },
    });

    expect(tenant.workspaceIntent.updatedAt).toBe(rerunUpdatedAt);
    expect(tenant.workspaceIntent.answers).toEqual(changedAnswers);
    expect(mocks.setupAuditCreate).not.toHaveBeenCalled();

    mocks.setupAuditCreate.mockClear();
    vi.setSystemTime(new Date("2026-08-30T12:02:00.000Z"));
    const legacyClientUpdate = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: { ...modules, courses: false },
        },
      },
    });

    expect(legacyClientUpdate.intent.answers).toEqual(changedAnswers);
    expect(tenant.workspaceIntent.answers).toEqual(changedAnswers);
    expect(mocks.setupAuditCreate).not.toHaveBeenCalled();
  });

  it.each(["time"] as const)(
    "keeps all module/navigation state unchanged for %s pricing answers",
    async (pricingMode) => {
      const answers = {
        sharedStudio: false,
        classes: false,
        memberships: false,
        vouchers: false,
        inventory: false,
      };
      tenant.modules.bookings = false;
      tenant.workspaceModules = {
        bookings: { selected: false, disabledAt: new Date("2026-01-01") },
        firing: { selected: true },
      };
      tenant.settings.navigation = {
        hiddenGroups: ["bookings"],
        hiddenItems: ["inventory"],
      };
      const modulesBefore = structuredClone(tenant.modules);
      const selectionsBefore = structuredClone(tenant.workspaceModules);
      const navigationBefore = structuredClone(tenant.settings.navigation);
      const result = await updateTenantWorkspaceConfiguration({
        tenantId: "tenant-1",
        actorUserId: ACTOR_ID,
        input: {
          intent: { definitionVersion: 2, answers, pricingMode },
          // Even an old or stale form cannot change tools with its answers.
          modules: { bookings: true, firing: false },
          navigation: { hiddenGroups: [], hiddenItems: [] },
        },
      });
      expect(result.intent).toMatchObject({ answers, pricingMode });
      expect(tenant.modules).toEqual(modulesBefore);
      expect(tenant.workspaceModules).toEqual(selectionsBefore);
      expect(tenant.settings.navigation).toEqual(navigationBefore);
      expect(save).toHaveBeenCalledOnce();
      expect(deleteOne).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    },
  );

  it("allows explicit manual module settings alongside initial confirmation", async () => {
    await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: { definitionVersion: 2 },
        modules: { bookings: false },
        navigation: { hiddenItems: ["calendar"] },
      },
    });
    expect(tenant.modules.bookings).toBe(false);
    expect(tenant.modules.firing).toBe(false);
    expect(tenant.settings.navigation.hiddenItems).toEqual(["calendar"]);
  });

  it("keeps legacy firing answers when v2 replaces the pricing question", async () => {
    const answers = {
      sharedStudio: true,
      classes: false,
      memberships: false,
      vouchers: false,
      inventory: false,
    };
    const confirmedAt = new Date("2026-01-01");
    tenant.workspaceIntent = {
      definitionVersion: 1,
      confirmedAt,
      updatedAt: confirmedAt,
      source: "owner",
      answers: { ...answers, firingServices: true },
    };
    const result = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: { intent: { definitionVersion: 2, answers, pricingMode: "time" } },
    });
    expect(result.intent).toMatchObject({
      definitionVersion: 2,
      pricingMode: "time",
      confirmedAt,
      answers: { ...answers, firingServices: true },
    });
  });

  it("returns null answers for a configured legacy intent", async () => {
    const confirmedAt = new Date("2026-08-01T12:00:00.000Z");
    tenant.workspaceIntent = {
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      confirmedAt,
      updatedAt: confirmedAt,
      source: TENANT_WORKSPACE_INTENT_SOURCE.LEGACY,
    };

    const result = await getTenantWorkspaceConfiguration("tenant-1");

    expect(result.intent).toMatchObject({
      configured: true,
      answers: null,
      source: TENANT_WORKSPACE_INTENT_SOURCE.LEGACY,
    });
  });

  it("preserves a stored selection while its module is outside the downgraded plan", async () => {
    const confirmedAt = new Date("2026-08-01T12:00:00.000Z");
    tenant.workspaceIntent = {
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      answers: {
        sharedStudio: true,
        classes: true,
        firingServices: false as const,
        memberships: true,
        vouchers: true,
        inventory: false,
      },
      confirmedAt,
      updatedAt: confirmedAt,
      source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
    };
    tenant.workspaceModules = {
      memberships: { selected: true },
      newsletter: { selected: true },
    };

    const modules = {
      bookings: true,
      payments: true,
      customers: true,
      courses: true,
      memberships: true,
      credits: false,
      vouchers: true,
      access_codes: false,
      automations: false,
      newsletter: true,
      firing: false as const,
      inventory: false,
      staff_tasks: false,
      communications: true,
      ai: true,
    };
    const answers = {
      ...tenant.workspaceIntent.answers,
      firingServices: false as const,
    };

    const result = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: {
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules,
          answers,
        },
      },
    });

    expect(result.modules.memberships).toMatchObject({
      entitled: false,
      selected: true,
      enabled: false,
    });
    expect(result.modules.newsletter).toMatchObject({
      entitled: false,
      selected: true,
      enabled: false,
    });
    expect(result.intent.answers).toEqual(answers);

    await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: { modules: { newsletter: false } },
    });
    expect(tenant.workspaceModules.newsletter).toMatchObject({
      selected: false,
    });

    await expect(
      updateTenantWorkspaceConfiguration({
        tenantId: "tenant-1",
        actorUserId: ACTOR_ID,
        input: { modules: { newsletter: true } },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_MODULE_NOT_ENTITLED",
      details: { module: "newsletter", currentPlan: TENANT_PLAN.STARTER },
    });
  });

  it("allows a legacy selected-by-default module outside the plan to round trip", async () => {
    tenant.workspaceModules = {};

    const result = await updateTenantWorkspaceConfiguration({
      tenantId: "tenant-1",
      actorUserId: ACTOR_ID,
      input: { modules: { newsletter: true } },
    });

    expect(result.modules.newsletter).toMatchObject({
      entitled: false,
      selected: true,
      enabled: false,
    });
    expect(tenant.workspaceModules.newsletter).toMatchObject({
      selected: true,
    });
  });

  it("rejects enabling a capability outside the plan", async () => {
    tenant.workspaceModules = { access_codes: { selected: false } };

    await expect(
      updateTenantWorkspaceConfiguration({
        tenantId: "tenant-1",
        actorUserId: ACTOR_ID,
        input: { modules: { access_codes: true } },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_MODULE_NOT_ENTITLED",
      details: { module: "access_codes", currentPlan: TENANT_PLAN.STARTER },
    });
    expect(save).not.toHaveBeenCalled();
  });
});
