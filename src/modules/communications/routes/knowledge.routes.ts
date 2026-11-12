import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { publicTenantLookupLimiter } from "@/modules/checkout/checkout.public-limiter.js";
import { loadPublishedTenant } from "@/modules/setup-center/setup-publication.middleware.js";
import {
  requirePermission,
  requireWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { requireTenantAiCapability } from "@/modules/tenants/middleware/requireTenantPlanCapability.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { loadAuthenticatedTenant } from "@/modules/tenants/middleware/loadAuthenticatedTenant.js";

import {
  createWorkspaceKnowledge,
  deleteWorkspaceKnowledge,
  getCustomerKnowledge,
  getPublicKnowledge,
  getWorkspaceKnowledge,
  listCustomerKnowledge,
  listPublicKnowledge,
  listWorkspaceKnowledge,
  updateWorkspaceKnowledge,
} from "../controllers/knowledge.controller.js";

const knowledgeHub = requireTenantAiCapability("knowledgeHub");
const aiModule = requireTenantModule(TENANT_MODULE.AI);

export const customerKnowledgeRouter = Router();
customerKnowledgeRouter.get(
  "/customer",
  verifyJWT,
  requireCustomerSession,
  loadAuthenticatedTenant,
  aiModule,
  knowledgeHub,
  listCustomerKnowledge,
);
customerKnowledgeRouter.get(
  "/customer/:id",
  verifyJWT,
  requireCustomerSession,
  loadAuthenticatedTenant,
  aiModule,
  knowledgeHub,
  getCustomerKnowledge,
);

export const publicKnowledgeRouter = Router();

publicKnowledgeRouter.get(
  "/tenants/:tenantSlug/knowledge",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  aiModule,
  knowledgeHub,
  listPublicKnowledge,
);
publicKnowledgeRouter.get(
  "/tenants/:tenantSlug/knowledge/:id",
  publicTenantLookupLimiter,
  loadPublishedTenant,
  aiModule,
  knowledgeHub,
  getPublicKnowledge,
);

export const workspaceKnowledgeRouter = Router();
workspaceKnowledgeRouter.use(requireWorkspaceAccess, aiModule);
workspaceKnowledgeRouter
  .route("/")
  .get(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_VIEW),
    listWorkspaceKnowledge,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    createWorkspaceKnowledge,
  );
workspaceKnowledgeRouter
  .route("/:id")
  .get(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_VIEW),
    getWorkspaceKnowledge,
  )
  .patch(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    updateWorkspaceKnowledge,
  )
  .delete(
    requirePermission(WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE),
    deleteWorkspaceKnowledge,
  );
