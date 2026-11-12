import { AI_FEATURE } from "../ai.constants.js";
import {
  AiConversationModel,
  AiFeedbackModel,
  AiRunModel,
} from "../ai.models.js";
import type { AiRequestContext } from "../ai.types.js";
import {
  getOrCreateAiSettings,
  isAiFeatureIncludedInPlan,
  resolveAiEntitlement,
  type AiFeatureSetting,
} from "./ai-access.service.js";
import { getAiUsage } from "./ai-usage.service.js";
import { notFound } from "@/shared/http/httpErrors.js";

const serializeSettings = (settings: any) => ({
  enabled: settings.enabled !== false,
  communicationsCopilotEnabled: settings.communicationsCopilotEnabled !== false,
  assistantEnabled: settings.assistantEnabled !== false,
  dailyBriefingEnabled: settings.dailyBriefingEnabled !== false,
  businessAdvisorEnabled: settings.businessAdvisorEnabled !== false,
  reportInsightsEnabled: settings.reportInsightsEnabled !== false,
  staffPlanningEnabled: settings.staffPlanningEnabled !== false,
  customerConciergeEnabled: settings.customerConciergeEnabled !== false,
  publicConciergeEnabled: settings.publicConciergeEnabled === true,
  publicConciergeHandoffEnabled:
    settings.publicConciergeHandoffEnabled !== false,
  firingIntelligenceEnabled: false,
  knowledgeBaseEnabled: settings.knowledgeBaseEnabled !== false,
  moderationEnabled: settings.moderationEnabled !== false,
  defaultLocale: settings.defaultLocale || "en",
  briefingTime: settings.briefingTime || "07:30",
  // Mutating actions are never configurable to auto-approve.
  requireActionConfirmation: true,
});

export const getAiCapabilities = async (tenantId: string) => {
  const [entitlement, usage] = await Promise.all([
    resolveAiEntitlement(tenantId),
    getAiUsage(tenantId),
  ]);
  const settings = serializeSettings(entitlement.settings);
  const baseEnabled = entitlement.canUseAi && settings.enabled;
  const featureEnabled = (setting: AiFeatureSetting) =>
    baseEnabled &&
    settings[setting] &&
    isAiFeatureIncludedInPlan(entitlement.tenant, setting);
  return {
    enabled: baseEnabled,
    features: {
      communicationsCopilot: featureEnabled("communicationsCopilotEnabled"),
      assistant: featureEnabled("assistantEnabled"),
      dailyBriefing: featureEnabled("dailyBriefingEnabled"),
      businessAdvisor: featureEnabled("businessAdvisorEnabled"),
      reportInsights: featureEnabled("reportInsightsEnabled"),
      staffPlanning: featureEnabled("staffPlanningEnabled"),
      customerConcierge: featureEnabled("customerConciergeEnabled"),
      publicConcierge: featureEnabled("publicConciergeEnabled"),
      firingIntelligence: featureEnabled("firingIntelligenceEnabled"),
      knowledgeBase: featureEnabled("knowledgeBaseEnabled"),
    },
    requireActionConfirmation: true,
    supportedFeatures: Object.values(AI_FEATURE).filter(
      (feature) => feature !== AI_FEATURE.FIRING_INTELLIGENCE,
    ),
    usage: {
      remaining: usage.remaining,
      limit: usage.limit,
      consumed: usage.consumed,
      reserved: usage.reserved,
      exhausted: usage.remaining <= 0,
      periodEnd: usage.periodEnd,
    },
  };
};

export const updateAiSettings = async (
  context: AiRequestContext,
  input: Record<string, unknown>,
) => {
  const settings = await getOrCreateAiSettings(
    context.tenantId,
    context.userId,
  );
  Object.assign(settings, input, { updatedBy: context.userId || null });
  await settings.save();
  return serializeSettings(settings);
};

export const createAiFeedback = async (
  context: AiRequestContext,
  input: {
    runId?: string | null;
    conversationId?: string | null;
    rating: string;
    comment: string;
  },
) => {
  if (!context.userId) notFound("AI result not found.");
  if (input.runId) {
    const run = await AiRunModel.exists({
      _id: input.runId,
      tenant: context.tenantId,
      $or: [{ actor: context.userId }, { actor: null }],
    });
    if (!run) notFound("AI result not found.");
  }
  if (input.conversationId) {
    const conversation = await AiConversationModel.exists({
      _id: input.conversationId,
      tenant: context.tenantId,
      user: context.userId,
    });
    if (!conversation) notFound("AI result not found.");
  }
  const filter = input.runId
    ? { tenant: context.tenantId, user: context.userId, run: input.runId }
    : {
        tenant: context.tenantId,
        user: context.userId,
        conversation: input.conversationId,
        run: null,
      };
  const feedback = await AiFeedbackModel.findOneAndUpdate(
    filter,
    {
      $set: {
        rating: input.rating,
        comment: input.comment,
        conversation: input.conversationId || null,
      },
      $setOnInsert: {
        tenant: context.tenantId,
        user: context.userId,
        run: input.runId || null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  return {
    id: String(feedback._id),
    rating: feedback.rating,
    comment: feedback.comment,
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
  };
};

export const aiManagementService = {
  capabilities: getAiCapabilities,
  usage: getAiUsage,
  getSettings: async (tenantId: string) =>
    serializeSettings(await getOrCreateAiSettings(tenantId)),
  updateSettings: updateAiSettings,
  feedback: createAiFeedback,
};
