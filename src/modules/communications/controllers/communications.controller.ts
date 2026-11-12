import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden } from "@/shared/http/httpErrors.js";

import {
  actionDecisionSchema,
  actionParamsSchema,
  aiDraftSchema,
  analyzeConversationSchema,
  assignConversationSchema,
  communicationIdParamsSchema,
  communicationOverviewSchema,
  communicationSettingsSchema,
  composeMessageSchema,
  consentSchema,
  createConversationSchema,
  createConversationTaskSchema,
  customerIdParamsSchema,
  fallbackDeliverySchema,
  internalNoteSchema,
  knowledgeArticleSchema,
  updateKnowledgeArticleSchema,
  listAuditSchema,
  listConversationsSchema,
  listKnowledgeSchema,
  listMessagesSchema,
  listSatisfactionSchema,
  replyMessageSchema,
  resolveConversationSchema,
  retryDeliverySchema,
  routingRuleSchema,
  translateMessageSchema,
  transcribeMessageSchema,
  updateConversationSchema,
} from "../communications.validators.js";
import {
  communicationManagementService,
  communicationService,
  type CommunicationContext,
} from "../services/communications.service.js";
import { enforceCommunicationRetentionForTenant } from "../services/retention.service.js";

const contextFrom = (req: Request): CommunicationContext => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);
  return {
    tenantId: requireTenantId(req),
    userId: getAuthenticatedUserId(req),
    role: access?.role,
    access,
    allowedLocationIds: getAllowedWorkspaceLocationIds(access),
    ipAddress: req.ip,
    userAgent: req.get("user-agent") || "",
  };
};

const ok = (res: Response, data: unknown, status = 200) => {
  res.status(status).json({ data });
};

const requireCommunicationPrivacyPermission = (req: Request): void => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);
  const allowed =
    hasWorkspacePermission(
      access,
      WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
    ) ||
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE);
  if (!allowed) {
    forbidden({
      message:
        "Communication settings permission is required to change privacy boundaries.",
      code: "COMMUNICATION_PRIVACY_PERMISSION_REQUIRED",
    });
  }
};

export const getCommunicationOverview = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationService.overview(
      contextFrom(req),
      communicationOverviewSchema.parse(req.query),
    ),
  ),
);

export const listConversations = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationService.listConversations(
      contextFrom(req),
      listConversationsSchema.parse(req.query),
    ),
  ),
);

export const createConversation = asyncHandler(async (req, res) => {
  const input = createConversationSchema.parse(req.body);
  if (input.restricted || input.allowedUserIds.length) {
    requireCommunicationPrivacyPermission(req);
  }
  ok(
    res,
    await communicationService.createConversation(contextFrom(req), input),
    201,
  );
});

export const getConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(res, await communicationService.getConversation(contextFrom(req), id));
});

export const updateConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  const input = updateConversationSchema.parse(req.body);
  const sensitiveFields = ["restricted", "allowedUserIds", "locationId"];
  if (sensitiveFields.some((field) => Object.hasOwn(input, field))) {
    requireCommunicationPrivacyPermission(req);
  }
  ok(
    res,
    await communicationService.updateConversation(contextFrom(req), id, input),
  );
});

export const listConversationMessages = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.listMessages(
      contextFrom(req),
      id,
      listMessagesSchema.parse(req.query),
    ),
  );
});

export const composeMessage = asyncHandler(async (req, res) => {
  const input = composeMessageSchema.parse(req.body);
  ok(
    res,
    await communicationService.compose(contextFrom(req), {
      ...input,
      // The public compose endpoint is operational-only. Normalize the legacy
      // "support" client value instead of trusting a browser-supplied purpose.
      purpose: "transactional",
    }),
    201,
  );
});

export const replyToConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.reply(
      contextFrom(req),
      id,
      replyMessageSchema.parse(req.body),
    ),
    201,
  );
});

export const addConversationNote = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.addNote(
      contextFrom(req),
      id,
      internalNoteSchema.parse(req.body),
    ),
    201,
  );
});

export const assignConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.assign(
      contextFrom(req),
      id,
      assignConversationSchema.parse(req.body),
    ),
  );
});

export const resolveConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.resolve(
      contextFrom(req),
      id,
      resolveConversationSchema.parse(req.body),
    ),
  );
});

export const createTaskFromConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.createTask(
      contextFrom(req),
      id,
      createConversationTaskSchema.parse(req.body),
    ),
    201,
  );
});

export const analyzeConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  analyzeConversationSchema.parse(req.body ?? {});
  ok(res, await communicationService.analyze(contextFrom(req), id));
});

export const draftConversationReply = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.draft(
      contextFrom(req),
      id,
      aiDraftSchema.parse(req.body),
    ),
  );
});

export const translateMessage = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.translate(
      contextFrom(req),
      id,
      translateMessageSchema.parse(req.body),
    ),
  );
});

export const transcribeMessage = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.transcribe(
      contextFrom(req),
      id,
      transcribeMessageSchema.parse(req.body),
    ),
  );
});

export const decideConversationAction = asyncHandler(async (req, res) => {
  const { id, actionId } = actionParamsSchema.parse(req.params);
  ok(
    res,
    await communicationService.decideAction(
      contextFrom(req),
      id,
      actionId,
      actionDecisionSchema.parse(req.body),
    ),
  );
});

export const createCustomerFromConversation = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(res, await communicationService.createCustomer(contextFrom(req), id), 201);
});

export const getCustomerCommunicationTimeline = asyncHandler(
  async (req, res) => {
    const { customerId } = customerIdParamsSchema.parse(req.params);
    ok(res, await communicationService.timeline(contextFrom(req), customerId));
  },
);

export const retryDelivery = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  const input = retryDeliverySchema.parse(req.body ?? {});
  ok(
    res,
    await communicationService.retryDelivery(
      requireTenantId(req),
      id,
      input.force,
    ),
  );
});

export const fallbackDelivery = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  const input = fallbackDeliverySchema.parse(req.body ?? {});
  ok(
    res,
    await communicationService.fallbackDelivery({
      tenantId: requireTenantId(req),
      deliveryId: id,
      requestedChannel: input.channel,
    }),
  );
});

export const listKnowledge = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.listKnowledge(
      contextFrom(req),
      listKnowledgeSchema.parse(req.query),
    ),
  ),
);

export const createKnowledge = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.createKnowledge(
      contextFrom(req),
      knowledgeArticleSchema.parse(req.body),
    ),
    201,
  ),
);

export const getKnowledge = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.getKnowledge(contextFrom(req), id),
  );
});

export const updateKnowledge = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.updateKnowledge(
      contextFrom(req),
      id,
      updateKnowledgeArticleSchema.parse(req.body),
    ),
  );
});

export const deleteKnowledge = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.deleteKnowledge(contextFrom(req), id),
  );
});

export const listRoutingRules = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.listRoutingRules(contextFrom(req)),
  ),
);

export const createRoutingRule = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.createRoutingRule(
      contextFrom(req),
      routingRuleSchema.parse(req.body),
    ),
    201,
  ),
);

export const updateRoutingRule = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.updateRoutingRule(
      contextFrom(req),
      id,
      routingRuleSchema.partial().parse(req.body),
    ),
  );
});

export const deleteRoutingRule = asyncHandler(async (req, res) => {
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.deleteRoutingRule(
      contextFrom(req),
      id,
    ),
  );
});

export const getCommunicationSettings = asyncHandler(async (req, res) =>
  ok(res, await communicationManagementService.getSettings(contextFrom(req))),
);

export const updateCommunicationSettings = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.updateSettings(
      contextFrom(req),
      communicationSettingsSchema.parse(req.body),
    ),
  ),
);

export const getCustomerConsents = asyncHandler(async (req, res) => {
  const { customerId } = customerIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.getConsents(
      contextFrom(req),
      customerId,
    ),
  );
});

export const updateCustomerConsents = asyncHandler(async (req, res) => {
  const { customerId } = customerIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.updateConsents(
      contextFrom(req),
      customerId,
      consentSchema.parse(req.body),
    ),
  );
});

export const listCommunicationAudit = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.listAudit(
      contextFrom(req),
      listAuditSchema.parse(req.query),
    ),
  ),
);

export const getSatisfactionAnalytics = asyncHandler(async (req, res) =>
  ok(
    res,
    await communicationManagementService.satisfaction(
      contextFrom(req),
      listSatisfactionSchema.parse(req.query),
    ),
  ),
);

export const runCommunicationRetention = asyncHandler(async (req, res) =>
  ok(res, await enforceCommunicationRetentionForTenant(requireTenantId(req))),
);
