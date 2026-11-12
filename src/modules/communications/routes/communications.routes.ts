import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireAnyPermission,
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import {
  requireTenantAiCapability,
  requireTenantCommunicationCapability,
} from "@/modules/tenants/middleware/requireTenantPlanCapability.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import {
  addConversationNote,
  analyzeConversation,
  assignConversation,
  composeMessage,
  createConversation,
  createCustomerFromConversation,
  createKnowledge,
  createRoutingRule,
  createTaskFromConversation,
  decideConversationAction,
  deleteKnowledge,
  deleteRoutingRule,
  draftConversationReply,
  fallbackDelivery,
  getCommunicationOverview,
  getCommunicationSettings,
  getConversation,
  getKnowledge,
  getCustomerCommunicationTimeline,
  getCustomerConsents,
  getSatisfactionAnalytics,
  listCommunicationAudit,
  listConversationMessages,
  listConversations,
  listKnowledge,
  listRoutingRules,
  replyToConversation,
  resolveConversation,
  runCommunicationRetention,
  retryDelivery,
  transcribeMessage,
  translateMessage,
  updateCommunicationSettings,
  updateConversation,
  updateCustomerConsents,
  updateKnowledge,
  updateRoutingRule,
} from "../controllers/communications.controller.js";

const router = express.Router();
router.use(verifyJWT);
// Consent, sender settings and retention remain manageable after a downgrade.
// Required system email delivery uses its separate routes and workers.
router.use(
  [
    "/overview",
    "/compose",
    "/conversations",
    "/messages",
    "/deliveries",
    "/customers",
    "/routing-rules",
    "/audit",
    "/satisfaction",
  ],
  requireTenantCommunicationCapability("unifiedInbox"),
);

const view = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);
const send = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);
const assign = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);
const manageSettings = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);
const viewAudit = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);

router.get("/overview", view, getCommunicationOverview);
router.post("/compose", send, composeMessage);

router
  .route("/conversations")
  .get(view, listConversations)
  .post(send, createConversation);
router
  .route("/conversations/:id")
  .get(view, getConversation)
  .patch(assign, updateConversation);
router.get("/conversations/:id/messages", view, listConversationMessages);
router.post("/conversations/:id/reply", send, replyToConversation);
router.post("/conversations/:id/notes", send, addConversationNote);
router.post("/conversations/:id/assign", assign, assignConversation);
router.post("/conversations/:id/resolve", assign, resolveConversation);
router.post(
  "/conversations/:id/task",
  send,
  requirePermission(WORKSPACE_PERMISSION.TASKS_MANAGE),
  createTaskFromConversation,
);
router.post(
  "/conversations/:id/customer",
  assign,
  requirePermission(WORKSPACE_PERMISSION.CUSTOMERS_MANAGE),
  createCustomerFromConversation,
);
router.post(
  "/conversations/:id/ai/analyze",
  send,
  requirePermission(WORKSPACE_PERMISSION.AI_USE),
  analyzeConversation,
);
router.post(
  "/conversations/:id/ai/draft",
  send,
  requirePermission(WORKSPACE_PERMISSION.AI_USE),
  draftConversationReply,
);
router.post(
  "/conversations/:id/actions/:actionId",
  assign,
  requirePermission(WORKSPACE_PERMISSION.TASKS_MANAGE),
  decideConversationAction,
);

router.post(
  "/messages/:id/translate",
  send,
  requirePermission(WORKSPACE_PERMISSION.AI_USE),
  translateMessage,
);
router.post(
  "/messages/:id/transcribe",
  send,
  requirePermission(WORKSPACE_PERMISSION.AI_USE),
  transcribeMessage,
);
router.post("/deliveries/:id/retry", send, retryDelivery);
router.post("/deliveries/:id/fallback", send, fallbackDelivery);

router.get(
  "/customers/:customerId/timeline",
  view,
  getCustomerCommunicationTimeline,
);
router.get("/consents/:customerId", view, getCustomerConsents);
router.put("/consents/:customerId", manageSettings, updateCustomerConsents);

// Compatibility aliases must enforce the same module and plan restrictions as
// the canonical /knowledge routes.
router.use(
  "/knowledge",
  requireTenantModule(TENANT_MODULE.AI),
  requireTenantAiCapability("knowledgeHub"),
);
router
  .route("/knowledge")
  .get(requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_VIEW), listKnowledge)
  .post(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    createKnowledge,
  );
router
  .route("/knowledge/:id")
  .get(requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_VIEW), getKnowledge)
  .patch(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    updateKnowledge,
  )
  .delete(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    deleteKnowledge,
  );

router
  .route("/routing-rules")
  .get(manageSettings, listRoutingRules)
  .post(manageSettings, createRoutingRule);
router
  .route("/routing-rules/:id")
  .patch(manageSettings, updateRoutingRule)
  .delete(manageSettings, deleteRoutingRule);

router
  .route("/settings")
  .get(manageSettings, getCommunicationSettings)
  .patch(manageSettings, updateCommunicationSettings);
router.get("/audit", viewAudit, listCommunicationAudit);
router.get("/satisfaction", viewAudit, getSatisfactionAnalytics);
router.post("/retention/run", manageSettings, runCommunicationRetention);

export default router;
