import type { Request, Response } from "express";
import type { z } from "zod";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { AI_AUDIENCE } from "./ai.constants.js";
import type { AiRequestContext } from "./ai.types.js";
import {
  aiActionParamsSchema,
  aiActionIdParamsSchema,
  aiConversationIdParamsSchema,
  aiFeedbackSchema,
  aiSettingsPatchSchema,
  briefingGenerateSchema,
  briefingLatestQuerySchema,
  businessAdvisorGenerateSchema,
  businessAdvisorRecommendationsQuerySchema,
  createAiConversationSchema,
  customerConciergeSchema,
  getAiActionSchema,
  listAiActionsSchema,
  listAiConversationsSchema,
  knowledgeCoverageQuerySchema,
  publicConciergeSchema,
  publicTenantAiParamsSchema,
  reportBriefingSchema,
  sendAiMessageSchema,
  staffPlanningBriefingSchema,
  staffPlanningDailyDraftSchema,
} from "./ai.validators.js";
import {
  confirmAiAction,
  dismissAiAction,
  getAiAction,
  listAiActions,
} from "./services/ai-action.service.js";
import { aiManagementService } from "./services/ai-management.service.js";
import { aiProviderHealthService } from "./services/ai-provider-health.service.js";
import { assistantService } from "./services/assistant.service.js";
import { briefingService } from "./services/briefing.service.js";
import { businessAdvisorService } from "./services/business-advisor.service.js";
import { conciergeService } from "./services/concierge.service.js";
import { knowledgeCoverageService } from "./services/knowledge-coverage.service.js";
import { reportBriefingService } from "./services/report-briefing.service.js";
import { staffPlanningAiService } from "./services/staff-planning-ai.service.js";

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ data });

const parseRequest = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    badRequest({
      message: "Invalid request.",
      code: "VALIDATION_ERROR",
      details: result.error.flatten(),
    });
  }
  return result.data;
};

const workspaceContext = (req: Request): AiRequestContext => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);
  return {
    tenantId: requireTenantId(req),
    userId: getAuthenticatedUserId(req),
    audience: AI_AUDIENCE.WORKSPACE,
    access,
    allowedLocationIds: getAllowedWorkspaceLocationIds(access),
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || "",
  };
};

const customerContext = (req: Request): AiRequestContext => ({
  tenantId: requireTenantId(req),
  userId: getAuthenticatedUserId(req),
  audience: AI_AUDIENCE.CUSTOMER,
  ipAddress: req.ip,
  userAgent: req.get("user-agent") || "",
});

export const getCapabilities = asyncHandler(async (req, res) =>
  ok(res, await aiManagementService.capabilities(requireTenantId(req))),
);
export const getUsage = asyncHandler(async (req, res) =>
  ok(res, await aiManagementService.usage(requireTenantId(req))),
);
export const getProviderHealth = asyncHandler(async (req, res) =>
  ok(res, await aiProviderHealthService.get(requireTenantId(req))),
);
export const getSettings = asyncHandler(async (req, res) =>
  ok(res, await aiManagementService.getSettings(requireTenantId(req))),
);
export const patchSettings = asyncHandler(async (req, res) =>
  ok(
    res,
    await aiManagementService.updateSettings(
      workspaceContext(req),
      parseRequest(aiSettingsPatchSchema, req.body),
    ),
  ),
);
export const submitFeedback = asyncHandler(async (req, res) =>
  ok(
    res,
    await aiManagementService.feedback(
      workspaceContext(req),
      parseRequest(aiFeedbackSchema, req.body),
    ),
    201,
  ),
);

export const listAssistantConversations = asyncHandler(async (req, res) =>
  ok(
    res,
    await assistantService.list(
      workspaceContext(req),
      parseRequest(listAiConversationsSchema, req.query),
    ),
  ),
);
export const createAssistantConversation = asyncHandler(async (req, res) =>
  ok(
    res,
    await assistantService.create(
      workspaceContext(req),
      parseRequest(createAiConversationSchema, req.body),
    ),
    201,
  ),
);
export const getAssistantConversation = asyncHandler(async (req, res) => {
  const { id } = parseRequest(aiConversationIdParamsSchema, req.params);
  ok(res, await assistantService.get(workspaceContext(req), id));
});
export const sendAssistantMessage = asyncHandler(async (req, res) => {
  const { id } = parseRequest(aiConversationIdParamsSchema, req.params);
  ok(
    res,
    await assistantService.sendMessage(
      workspaceContext(req),
      id,
      parseRequest(sendAiMessageSchema, req.body),
    ),
  );
});
export const confirmAssistantAction = asyncHandler(async (req, res) => {
  const { id, actionId } = parseRequest(aiActionParamsSchema, req.params);
  ok(
    res,
    await confirmAiAction({
      context: workspaceContext(req),
      conversationId: id,
      actionId,
    }),
  );
});

export const dismissAssistantAction = asyncHandler(async (req, res) => {
  const { id, actionId } = parseRequest(aiActionParamsSchema, req.params);
  ok(
    res,
    await dismissAiAction({
      context: workspaceContext(req),
      conversationId: id,
      actionId,
    }),
  );
});

export const listActions = asyncHandler(async (req, res) =>
  ok(
    res,
    await listAiActions({
      context: workspaceContext(req),
      input: parseRequest(listAiActionsSchema, req.query),
    }),
  ),
);

export const getAction = asyncHandler(async (req, res) => {
  const { actionId } = parseRequest(aiActionIdParamsSchema, req.params);
  const { scope } = parseRequest(getAiActionSchema, req.query);
  ok(
    res,
    await getAiAction({
      context: workspaceContext(req),
      actionId,
      scope,
    }),
  );
});

export const confirmAction = asyncHandler(async (req, res) => {
  const { actionId } = parseRequest(aiActionIdParamsSchema, req.params);
  ok(
    res,
    await confirmAiAction({
      context: workspaceContext(req),
      actionId,
    }),
  );
});

export const dismissAction = asyncHandler(async (req, res) => {
  const { actionId } = parseRequest(aiActionIdParamsSchema, req.params);
  ok(
    res,
    await dismissAiAction({
      context: workspaceContext(req),
      actionId,
    }),
  );
});

export const latestBriefing = asyncHandler(async (req, res) =>
  ok(
    res,
    await briefingService.latest(
      workspaceContext(req),
      parseRequest(briefingLatestQuerySchema, req.query),
    ),
  ),
);
export const generateBriefing = asyncHandler(async (req, res) =>
  ok(
    res,
    await briefingService.generate(
      workspaceContext(req),
      parseRequest(briefingGenerateSchema, req.body ?? {}),
    ),
  ),
);

export const getBusinessAdvisorRecommendations = asyncHandler(
  async (req, res) =>
    ok(
      res,
      await businessAdvisorService.recommendations(
        workspaceContext(req),
        parseRequest(businessAdvisorRecommendationsQuerySchema, req.query),
      ),
    ),
);

export const generateBusinessAdvisor = asyncHandler(async (req, res) =>
  ok(
    res,
    await businessAdvisorService.generate(
      workspaceContext(req),
      parseRequest(businessAdvisorGenerateSchema, req.body ?? {}),
    ),
  ),
);

export const generateReportInsights = asyncHandler(async (req, res) =>
  ok(
    res,
    await reportBriefingService.generate(
      workspaceContext(req),
      parseRequest(reportBriefingSchema, req.body ?? {}),
    ),
  ),
);

export const getKnowledgeCoverage = asyncHandler(async (req, res) =>
  ok(
    res,
    await knowledgeCoverageService.get({
      context: workspaceContext(req),
      ...parseRequest(knowledgeCoverageQuerySchema, req.query),
    }),
  ),
);

export const generateStaffPlanningBriefing = asyncHandler(async (req, res) =>
  ok(
    res,
    await staffPlanningAiService.briefing(
      workspaceContext(req),
      parseRequest(staffPlanningBriefingSchema, req.body ?? {}),
    ),
  ),
);

export const generateStaffPlanningDailyDraft = asyncHandler(async (req, res) =>
  ok(
    res,
    await staffPlanningAiService.dailyDraft(
      workspaceContext(req),
      parseRequest(staffPlanningDailyDraftSchema, req.body ?? {}),
    ),
  ),
);

export const customerConciergeConfig = asyncHandler(async (req, res) =>
  ok(res, await conciergeService.customerConfig(requireTenantId(req))),
);
export const customerConcierge = asyncHandler(async (req, res) =>
  ok(
    res,
    await conciergeService.customer(
      customerContext(req),
      parseRequest(customerConciergeSchema, req.body),
    ),
  ),
);
export const publicConciergeConfig = asyncHandler(async (req, res) => {
  const { tenantSlug } = parseRequest(publicTenantAiParamsSchema, req.params);
  ok(res, await conciergeService.publicConfig(tenantSlug));
});
export const publicConcierge = asyncHandler(async (req, res) => {
  const { tenantSlug } = parseRequest(publicTenantAiParamsSchema, req.params);
  ok(
    res,
    await conciergeService.public(
      tenantSlug,
      parseRequest(publicConciergeSchema, req.body),
      { ipAddress: req.ip, userAgent: req.get("user-agent") || "" },
    ),
  );
});
