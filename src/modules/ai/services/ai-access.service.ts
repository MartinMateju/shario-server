import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import { AiSettingsModel } from "@/modules/ai/ai.models.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { forbidden } from "@/shared/http/httpErrors.js";

export type AiFeatureSetting = keyof {
  communicationsCopilotEnabled: boolean;
  assistantEnabled: boolean;
  dailyBriefingEnabled: boolean;
  businessAdvisorEnabled: boolean;
  reportInsightsEnabled: boolean;
  staffPlanningEnabled: boolean;
  customerConciergeEnabled: boolean;
  publicConciergeEnabled: boolean;
  firingIntelligenceEnabled: boolean;
  knowledgeBaseEnabled: boolean;
};

export const isAiFeatureIncludedInPlan = (
  tenant: { plan?: string; planVersion?: number },
  featureSetting?: AiFeatureSetting,
): boolean => {
  if (!featureSetting) return true;
  // The old setting is retained only for compatibility with stored AI settings.
  if (featureSetting === "firingIntelligenceEnabled") return false;
  if (
    !Object.values(TENANT_PLAN).includes(tenant.plan as TenantPlan) ||
    !Number.isInteger(tenant.planVersion)
  ) {
    // Legacy fixtures and records predate the granular V2 capability contract.
    return true;
  }

  const capabilities = getPlanConfig(
    tenant.plan as TenantPlan,
    tenant.planVersion,
  ).capabilities?.ai;

  if (!capabilities) return true;

  switch (featureSetting) {
    case "assistantEnabled":
      return capabilities.studioAssistant !== "none";
    case "dailyBriefingEnabled":
      return capabilities.dailyStudioBriefing;
    case "knowledgeBaseEnabled":
      return capabilities.knowledgeHub;
    case "customerConciergeEnabled":
    case "publicConciergeEnabled":
      return capabilities.knowledgeAwareCustomerAssistant;
    case "businessAdvisorEnabled":
      return capabilities.businessAdvisor;
    case "communicationsCopilotEnabled":
    case "reportInsightsEnabled":
    case "staffPlanningEnabled":
      return capabilities.commandCenter;
  }
};

export const getOrCreateAiSettings = async (
  tenantId: string,
  userId?: string | null,
) => {
  return AiSettingsModel.findOneAndUpdate(
    { tenant: tenantId },
    {
      $setOnInsert: {
        tenant: tenantId,
        updatedBy: userId || null,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export const resolveAiEntitlement = async (tenantId: string) => {
  const { tenant, subscription, access } =
    await getTenantSubscriptionAccess(tenantId);
  const settings = await getOrCreateAiSettings(tenantId);
  const moduleEnabled = tenant.modules?.ai === true;
  const creditLimit = Math.max(Number(tenant.limits?.aiCredits || 0), 0);

  return {
    tenant,
    subscription,
    subscriptionAccess: access,
    settings,
    moduleEnabled,
    creditLimit,
    canUseAi:
      access.canUseFeatures &&
      moduleEnabled &&
      creditLimit > 0 &&
      settings.enabled !== false,
  };
};

export const requireAiEntitlement = async (
  tenantId: string,
  featureSetting?: AiFeatureSetting,
) => {
  const entitlement = await resolveAiEntitlement(tenantId);

  if (!entitlement.subscriptionAccess.canUseFeatures) {
    forbidden({
      message: "An active tenant subscription is required to use AI features.",
      code: "TENANT_SUBSCRIPTION_REQUIRED",
      details: entitlement.subscriptionAccess,
    });
  }
  if (!entitlement.moduleEnabled || entitlement.creditLimit <= 0) {
    forbidden({
      message: "AI is not included in this workspace plan.",
      code: "AI_PLAN_REQUIRED",
    });
  }
  if (entitlement.settings.enabled === false) {
    forbidden({
      message: "AI is disabled for this workspace.",
      code: "AI_DISABLED",
    });
  }
  if (!isAiFeatureIncludedInPlan(entitlement.tenant, featureSetting)) {
    forbidden({
      message: "This AI feature is not included in the workspace plan.",
      code: "AI_FEATURE_PLAN_REQUIRED",
      details: { feature: featureSetting },
    });
  }
  if (featureSetting && entitlement.settings[featureSetting] === false) {
    forbidden({
      message: "This AI feature is disabled for the workspace.",
      code: "AI_FEATURE_DISABLED",
      details: { feature: featureSetting },
    });
  }
  return entitlement;
};

export const aiAccessService = {
  getOrCreateSettings: getOrCreateAiSettings,
  resolveEntitlement: resolveAiEntitlement,
  requireEntitlement: requireAiEntitlement,
};
