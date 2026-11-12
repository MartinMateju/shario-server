import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveEntitlement: vi.fn(),
  getSettings: vi.fn(),
  getUsage: vi.fn(),
  runExists: vi.fn(),
  conversationExists: vi.fn(),
  feedbackFindOneAndUpdate: vi.fn(),
}));

vi.mock(
  "@/modules/ai/services/ai-access.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/ai/services/ai-access.service.js")
    >()),
    resolveAiEntitlement: mocks.resolveEntitlement,
    getOrCreateAiSettings: mocks.getSettings,
  }),
);
vi.mock("@/modules/ai/services/ai-usage.service.js", () => ({
  getAiUsage: mocks.getUsage,
}));
vi.mock("@/modules/ai/ai.models.js", () => ({
  AiRunModel: { exists: mocks.runExists },
  AiConversationModel: { exists: mocks.conversationExists },
  AiFeedbackModel: { findOneAndUpdate: mocks.feedbackFindOneAndUpdate },
}));

import {
  createAiFeedback,
  getAiCapabilities,
  updateAiSettings,
} from "@/modules/ai/services/ai-management.service.js";
import { AI_AUDIENCE } from "@/modules/ai/ai.constants.js";
import type { AiRequestContext } from "@/modules/ai/ai.types.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const RUN_ID = "507f1f77bcf86cd799439013";
const CONVERSATION_ID = "507f1f77bcf86cd799439014";

const context: AiRequestContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  audience: AI_AUDIENCE.WORKSPACE,
};

const settings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  communicationsCopilotEnabled: true,
  assistantEnabled: true,
  dailyBriefingEnabled: true,
  reportInsightsEnabled: true,
  customerConciergeEnabled: true,
  publicConciergeEnabled: false,
  publicConciergeHandoffEnabled: true,
  firingIntelligenceEnabled: true,
  knowledgeBaseEnabled: true,
  moderationEnabled: true,
  defaultLocale: "en",
  briefingTime: "07:30",
  updatedBy: null,
  save: vi.fn(),
  ...overrides,
});

describe("AI management service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEntitlement.mockResolvedValue({
      tenant: { plan: "studio_plus", planVersion: 3 },
      canUseAi: true,
      moduleEnabled: true,
      creditLimit: 500,
      subscriptionAccess: { reason: "internal-only" },
      settings: settings(),
    });
    mocks.getSettings.mockResolvedValue(settings());
    mocks.getUsage.mockResolvedValue({
      remaining: 400,
      limit: 500,
      consumed: 90,
      reserved: 10,
      periodEnd: new Date("2026-08-01T00:00:00.000Z"),
    });
    mocks.runExists.mockResolvedValue({ _id: RUN_ID });
    mocks.conversationExists.mockResolvedValue({ _id: CONVERSATION_ID });
    mocks.feedbackFindOneAndUpdate.mockResolvedValue({
      _id: "507f1f77bcf86cd799439020",
      rating: "helpful",
      comment: "Useful",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("returns feature capabilities and bounded usage without leaking subscription diagnostics", async () => {
    const result = await getAiCapabilities(TENANT_ID);

    expect(result).toEqual(
      expect.objectContaining({
        enabled: true,
        requireActionConfirmation: true,
        features: expect.objectContaining({
          assistant: true,
          reportInsights: true,
          publicConcierge: false,
        }),
        usage: expect.objectContaining({
          remaining: 400,
          limit: 500,
          exhausted: false,
        }),
      }),
    );
    expect(result).not.toHaveProperty("subscriptionAccess");
    expect(JSON.stringify(result)).not.toContain("internal-only");
  });

  it("updates only tenant settings and never makes mutating AI actions auto-approved", async () => {
    const document = settings();
    document.save.mockResolvedValue(document);
    mocks.getSettings.mockResolvedValueOnce(document);

    const result = await updateAiSettings(context, {
      assistantEnabled: false,
      publicConciergeEnabled: true,
    });

    expect(mocks.getSettings).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(document.assistantEnabled).toBe(false);
    expect(document.publicConciergeEnabled).toBe(true);
    expect(document.updatedBy).toBe(USER_ID);
    expect(document.save).toHaveBeenCalledOnce();
    expect(result.requireActionConfirmation).toBe(true);
  });

  it.each([
    ["starter", 3, ["assistant"]],
    ["professional", 3, ["assistant", "dailyBriefing", "knowledgeBase"]],
    [
      "studio_plus",
      3,
      [
        "communicationsCopilot",
        "assistant",
        "dailyBriefing",
        "businessAdvisor",
        "reportInsights",
        "staffPlanning",
        "customerConcierge",
        "publicConcierge",
        "knowledgeBase",
      ],
    ],
    [
      "enterprise",
      3,
      [
        "communicationsCopilot",
        "assistant",
        "dailyBriefing",
        "businessAdvisor",
        "reportInsights",
        "staffPlanning",
        "customerConcierge",
        "publicConcierge",
        "knowledgeBase",
      ],
    ],
    ["professional", 2, ["assistant", "dailyBriefing", "knowledgeBase"]],
  ])(
    "only advertises enabled AI features included in %s V%s",
    async (plan, planVersion, enabledFeatures) => {
      mocks.resolveEntitlement.mockResolvedValue({
        tenant: { plan, planVersion },
        canUseAi: true,
        settings: settings({ publicConciergeEnabled: true }),
      });

      const result = await getAiCapabilities(TENANT_ID);

      expect(
        Object.entries(result.features)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .sort(),
      ).toEqual([...enabledFeatures].sort());
    },
  );

  it.each([
    { canUseAi: false, settings: settings() },
    { canUseAi: true, settings: settings({ enabled: false }) },
  ])(
    "does not advertise AI while workspace-wide access is disabled",
    async (input) => {
      mocks.resolveEntitlement.mockResolvedValue({
        tenant: { plan: "studio_plus", planVersion: 3 },
        ...input,
      });

      const result = await getAiCapabilities(TENANT_ID);

      expect(result.enabled).toBe(false);
      expect(Object.values(result.features)).not.toContain(true);
    },
  );

  it("honors individual feature settings without hiding other included features", async () => {
    mocks.resolveEntitlement.mockResolvedValue({
      tenant: { plan: "professional", planVersion: 3 },
      canUseAi: true,
      settings: settings({ firingIntelligenceEnabled: false }),
    });

    expect((await getAiCapabilities(TENANT_ID)).features).toMatchObject({
      firingIntelligence: false,
      dailyBriefing: true,
      knowledgeBase: true,
      businessAdvisor: false,
    });
  });

  it("rejects feedback for a run outside the current tenant/actor before writing", async () => {
    mocks.runExists.mockResolvedValueOnce(null);

    await expect(
      createAiFeedback(context, {
        runId: RUN_ID,
        conversationId: null,
        rating: "helpful",
        comment: "Useful",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.runExists).toHaveBeenCalledWith({
      _id: RUN_ID,
      tenant: TENANT_ID,
      $or: [{ actor: USER_ID }, { actor: null }],
    });
    expect(mocks.feedbackFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("pins conversation feedback and its idempotent upsert to tenant and actor", async () => {
    await createAiFeedback(context, {
      runId: null,
      conversationId: CONVERSATION_ID,
      rating: "helpful",
      comment: "Useful",
    });

    expect(mocks.conversationExists).toHaveBeenCalledWith({
      _id: CONVERSATION_ID,
      tenant: TENANT_ID,
      user: USER_ID,
    });
    expect(mocks.feedbackFindOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: TENANT_ID,
        user: USER_ID,
        conversation: CONVERSATION_ID,
        run: null,
      },
      expect.objectContaining({
        $setOnInsert: {
          tenant: TENANT_ID,
          user: USER_ID,
          run: null,
        },
      }),
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );
  });
});
