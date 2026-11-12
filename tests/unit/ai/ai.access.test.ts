import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantSubscriptionAccess: vi.fn(),
  settingsFindOneAndUpdate: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-subscription/services/tenant-subscription.service.js",
  () => ({
    getTenantSubscriptionAccess: mocks.getTenantSubscriptionAccess,
  }),
);

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiSettingsModel: {
    findOneAndUpdate: mocks.settingsFindOneAndUpdate,
  },
}));

import {
  getOrCreateAiSettings,
  requireAiEntitlement,
  resolveAiEntitlement,
} from "@/modules/ai/services/ai-access.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";

const settings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  communicationsCopilotEnabled: true,
  assistantEnabled: true,
  dailyBriefingEnabled: true,
  customerConciergeEnabled: true,
  publicConciergeEnabled: true,
  firingIntelligenceEnabled: true,
  knowledgeBaseEnabled: true,
  ...overrides,
});

const subscriptionResult = (overrides: Record<string, any> = {}) => ({
  tenant: {
    _id: TENANT_ID,
    plan: "professional",
    planVersion: 1,
    modules: { ai: true },
    limits: { aiCredits: 1_000 },
    ...(overrides.tenant ?? {}),
  },
  subscription: {
    status: "active",
    ...(overrides.subscription ?? {}),
  },
  access: {
    canUseFeatures: true,
    mode: "full",
    ...(overrides.access ?? {}),
  },
});

describe("AI settings and entitlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantSubscriptionAccess.mockResolvedValue(subscriptionResult());
    mocks.settingsFindOneAndUpdate.mockResolvedValue(settings());
  });

  it("creates tenant-scoped defaults without accepting settings from a caller", async () => {
    await getOrCreateAiSettings(TENANT_ID, USER_ID);

    expect(mocks.settingsFindOneAndUpdate).toHaveBeenCalledWith(
      { tenant: TENANT_ID },
      {
        $setOnInsert: {
          tenant: TENANT_ID,
          updatedBy: USER_ID,
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  });

  it("resolves plan, subscription and settings into one entitlement", async () => {
    await expect(resolveAiEntitlement(TENANT_ID)).resolves.toMatchObject({
      moduleEnabled: true,
      creditLimit: 1_000,
      canUseAi: true,
    });

    expect(mocks.getTenantSubscriptionAccess).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.settingsFindOneAndUpdate).toHaveBeenCalledWith(
      { tenant: TENANT_ID },
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("never treats malformed or negative plan credits as usable", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({ tenant: { limits: { aiCredits: -50 } } }),
    );

    await expect(resolveAiEntitlement(TENANT_ID)).resolves.toMatchObject({
      creditLimit: 0,
      canUseAi: false,
    });
  });

  it("fails first on an unavailable tenant subscription", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({
        tenant: { modules: { ai: false }, limits: { aiCredits: 0 } },
        access: { canUseFeatures: false, reason: "trial_expired" },
      }),
    );

    await expect(
      requireAiEntitlement(TENANT_ID, "assistantEnabled"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_SUBSCRIPTION_REQUIRED",
    });
  });

  it.each([
    [{ modules: { ai: false }, limits: { aiCredits: 1_000 } }, "module"],
    [{ modules: { ai: true }, limits: { aiCredits: 0 } }, "credits"],
  ])("rejects a plan without AI entitlement (%s)", async (tenant) => {
    mocks.getTenantSubscriptionAccess.mockResolvedValueOnce(
      subscriptionResult({ tenant }),
    );

    await expect(requireAiEntitlement(TENANT_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: "AI_PLAN_REQUIRED",
    });
  });

  it("honors the workspace-wide AI kill switch", async () => {
    mocks.settingsFindOneAndUpdate.mockResolvedValueOnce(
      settings({ enabled: false }),
    );

    await expect(requireAiEntitlement(TENANT_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: "AI_DISABLED",
    });
  });

  it("honors a feature-level switch without disabling other AI features", async () => {
    mocks.settingsFindOneAndUpdate.mockResolvedValue(
      settings({ publicConciergeEnabled: false }),
    );

    await expect(
      requireAiEntitlement(TENANT_ID, "publicConciergeEnabled"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AI_FEATURE_DISABLED",
      details: { feature: "publicConciergeEnabled" },
    });
    await expect(
      requireAiEntitlement(TENANT_ID, "assistantEnabled"),
    ).resolves.toMatchObject({ canUseAi: true });
  });

  it("enforces the granular V2 AI capability contract", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValue(
      subscriptionResult({
        tenant: { plan: "starter", planVersion: 2 },
      }),
    );

    await expect(
      requireAiEntitlement(TENANT_ID, "assistantEnabled"),
    ).resolves.toMatchObject({ canUseAi: true });
    await expect(
      requireAiEntitlement(TENANT_ID, "dailyBriefingEnabled"),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "AI_FEATURE_PLAN_REQUIRED",
      details: { feature: "dailyBriefingEnabled" },
    });
  });

  it("includes Professional briefing and knowledge without Plus-only AI tools", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValue(
      subscriptionResult({
        tenant: { plan: "professional", planVersion: 2 },
      }),
    );

    await expect(
      requireAiEntitlement(TENANT_ID, "dailyBriefingEnabled"),
    ).resolves.toMatchObject({ canUseAi: true });
    await expect(
      requireAiEntitlement(TENANT_ID, "knowledgeBaseEnabled"),
    ).resolves.toMatchObject({ canUseAi: true });
    await expect(
      requireAiEntitlement(TENANT_ID, "businessAdvisorEnabled"),
    ).rejects.toMatchObject({ code: "AI_FEATURE_PLAN_REQUIRED" });
  });

  it.each([
    ["starter", 3, false],
    ["professional", 3, false],
    ["studio_plus", 3, false],
    ["enterprise", 3, false],
    ["professional", 2, false],
    ["studio_plus", 2, false],
  ])(
    "keeps retired firing intelligence unavailable on %s V%s",
    async (plan, planVersion, included) => {
      mocks.getTenantSubscriptionAccess.mockResolvedValue(
        subscriptionResult({ tenant: { plan, planVersion } }),
      );

      const result = requireAiEntitlement(
        TENANT_ID,
        "firingIntelligenceEnabled",
      );
      if (included) {
        await expect(result).resolves.toMatchObject({ canUseAi: true });
      } else {
        await expect(result).rejects.toMatchObject({
          statusCode: 403,
          code: "AI_FEATURE_PLAN_REQUIRED",
        });
      }
    },
  );

  it("keeps firing intelligence retired even when old settings contain its switch", async () => {
    mocks.getTenantSubscriptionAccess.mockResolvedValue(
      subscriptionResult({ tenant: { plan: "professional", planVersion: 3 } }),
    );
    mocks.settingsFindOneAndUpdate.mockResolvedValue(
      settings({ firingIntelligenceEnabled: false }),
    );

    await expect(
      requireAiEntitlement(TENANT_ID, "firingIntelligenceEnabled"),
    ).rejects.toMatchObject({ code: "AI_FEATURE_PLAN_REQUIRED" });
  });
});
