import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { loadPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";
import {
  requireAnyPermission,
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  confirmAction,
  confirmAssistantAction,
  createAssistantConversation,
  customerConcierge,
  customerConciergeConfig,
  dismissAction,
  dismissAssistantAction,
  generateBriefing,
  generateBusinessAdvisor,
  generateReportInsights,
  generateStaffPlanningBriefing,
  generateStaffPlanningDailyDraft,
  getAssistantConversation,
  getAction,
  getCapabilities,
  getBusinessAdvisorRecommendations,
  getKnowledgeCoverage,
  getProviderHealth,
  getSettings,
  getUsage,
  latestBriefing,
  listActions,
  listAssistantConversations,
  patchSettings,
  publicConcierge,
  publicConciergeConfig,
  sendAssistantMessage,
  submitFeedback,
} from "./ai.controller.js";
import {
  publicAiLookupLimiter,
  publicAiMessageLimiter,
  workspaceAiBriefingLimiter,
  workspaceAiMessageLimiter,
} from "./ai.limiter.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { loadAuthenticatedTenant } from "@/modules/tenants/middleware/loadAuthenticatedTenant.js";
import { requireTenantAiCapability } from "@/modules/tenants/middleware/requireTenantPlanCapability.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const knowledgeHub = requireTenantAiCapability("knowledgeHub");
const knowledgeAwareCustomerAssistant = requireTenantAiCapability(
  "knowledgeAwareCustomerAssistant",
);
const commandCenter = requireTenantAiCapability("commandCenter");
const dailyStudioBriefing = requireTenantAiCapability("dailyStudioBriefing");
const businessAdvisor = requireTenantAiCapability("businessAdvisor");

export const publicAiRouter = Router();
publicAiRouter.get(
  "/tenants/:tenantSlug/ai/concierge/config",
  publicAiLookupLimiter,
  loadPublishedTenant,
  publicConciergeConfig,
);
publicAiRouter.post(
  "/tenants/:tenantSlug/ai/concierge",
  publicAiMessageLimiter,
  loadPublishedTenant,
  knowledgeAwareCustomerAssistant,
  publicConcierge,
);

export const aiRouter = Router();
aiRouter.use(verifyJWT);

// Mounted before the tenant feature-subscription boundary so the customer UI
// can safely learn `{ enabled: false }` without receiving plan/credit details.
export const customerAiRouter = Router();
customerAiRouter.use(verifyJWT, requireCustomerSession);
customerAiRouter.get("/concierge/config", customerConciergeConfig);
customerAiRouter.post(
  "/concierge",
  loadAuthenticatedTenant,
  knowledgeAwareCustomerAssistant,
  customerConcierge,
);

aiRouter.use(requireWorkspaceAccess);
const useAi = requirePermission(WORKSPACE_PERMISSION.AI_USE);
const inspectAi = requireAnyPermission(
  WORKSPACE_PERMISSION.AI_USE,
  WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
);
const inspectAiUsage = requireAnyPermission(
  WORKSPACE_PERMISSION.AI_AUDIT_VIEW,
  WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
);

aiRouter.get("/capabilities", inspectAi, getCapabilities);
aiRouter.get("/usage", inspectAiUsage, getUsage);
aiRouter.get("/provider-health", inspectAiUsage, getProviderHealth);
aiRouter.get(
  "/knowledge/coverage",
  useAi,
  knowledgeHub,
  requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_VIEW),
  getKnowledgeCoverage,
);

aiRouter
  .route("/assistant/conversations")
  .get(useAi, listAssistantConversations)
  .post(useAi, createAssistantConversation);
aiRouter.get("/assistant/conversations/:id", useAi, getAssistantConversation);
aiRouter.post(
  "/assistant/conversations/:id/messages",
  useAi,
  workspaceAiMessageLimiter,
  sendAssistantMessage,
);
aiRouter.post(
  "/assistant/conversations/:id/actions/:actionId/confirm",
  useAi,
  commandCenter,
  confirmAssistantAction,
);
aiRouter.post(
  "/assistant/conversations/:id/actions/:actionId/dismiss",
  useAi,
  commandCenter,
  dismissAssistantAction,
);

aiRouter.get("/actions", useAi, commandCenter, listActions);
aiRouter.get("/actions/:actionId", useAi, commandCenter, getAction);
aiRouter.post(
  "/actions/:actionId/confirm",
  useAi,
  commandCenter,
  confirmAction,
);
aiRouter.post(
  "/actions/:actionId/dismiss",
  useAi,
  commandCenter,
  dismissAction,
);

aiRouter.get("/briefings/latest", useAi, dailyStudioBriefing, latestBriefing);
aiRouter.post(
  "/briefings/generate",
  useAi,
  dailyStudioBriefing,
  workspaceAiBriefingLimiter,
  generateBriefing,
);
aiRouter.get(
  "/advisor/recommendations",
  useAi,
  businessAdvisor,
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  getBusinessAdvisorRecommendations,
);
aiRouter.post(
  "/advisor/generate",
  useAi,
  businessAdvisor,
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  workspaceAiBriefingLimiter,
  generateBusinessAdvisor,
);
aiRouter.post(
  "/reports/briefing",
  useAi,
  businessAdvisor,
  requirePermission(WORKSPACE_PERMISSION.REPORTS_VIEW),
  generateReportInsights,
);
aiRouter.post(
  "/staff-planning/daily-draft",
  useAi,
  requireTenantModule(TENANT_MODULE.STAFF_TASKS),
  requirePermission(WORKSPACE_PERMISSION.PLANNING_SUBMIT),
  requirePermission(WORKSPACE_PERMISSION.TASKS_VIEW),
  generateStaffPlanningDailyDraft,
);
aiRouter.post(
  "/staff-planning/briefing",
  useAi,
  requireTenantModule(TENANT_MODULE.STAFF_TASKS),
  requireAnyPermission(
    WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
    WORKSPACE_PERMISSION.PLANNING_MANAGE,
  ),
  generateStaffPlanningBriefing,
);

aiRouter.get("/settings", inspectAi, getSettings);
aiRouter.patch(
  "/settings",
  requirePermission(WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE),
  patchSettings,
);
aiRouter.post("/feedback", useAi, submitFeedback);

export default aiRouter;
