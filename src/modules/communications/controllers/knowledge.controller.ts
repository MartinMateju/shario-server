import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  communicationIdParamsSchema,
  knowledgeArticleSchema,
  listKnowledgeSchema,
  listPublishedKnowledgeSchema,
  updateKnowledgeArticleSchema,
} from "../communications.validators.js";
import {
  communicationManagementService,
  type CommunicationContext,
} from "../services/communications.service.js";
import { knowledgePortalService } from "../services/knowledge.service.js";

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ data });

const workspaceContext = (req: Request): CommunicationContext => {
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

const privateResponse = (res: Response) => {
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Authorization");
};

export const listWorkspaceKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  ok(
    res,
    await communicationManagementService.listKnowledge(
      workspaceContext(req),
      listKnowledgeSchema.parse(req.query),
    ),
  );
});

export const createWorkspaceKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  ok(
    res,
    await communicationManagementService.createKnowledge(
      workspaceContext(req),
      knowledgeArticleSchema.parse(req.body),
    ),
    201,
  );
});

export const getWorkspaceKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.getKnowledge(
      workspaceContext(req),
      id,
    ),
  );
});

export const updateWorkspaceKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.updateKnowledge(
      workspaceContext(req),
      id,
      updateKnowledgeArticleSchema.parse(req.body),
    ),
  );
});

export const deleteWorkspaceKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await communicationManagementService.deleteKnowledge(
      workspaceContext(req),
      id,
    ),
  );
});

export const listCustomerKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  ok(
    res,
    await knowledgePortalService.list(
      {
        kind: "customer",
        tenantId: requireTenantId(req),
        userId: getAuthenticatedUserId(req),
      },
      listPublishedKnowledgeSchema.parse(req.query),
    ),
  );
});

export const getCustomerKnowledge = asyncHandler(async (req, res) => {
  privateResponse(res);
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await knowledgePortalService.get(
      {
        kind: "customer",
        tenantId: requireTenantId(req),
        userId: getAuthenticatedUserId(req),
      },
      id,
      listPublishedKnowledgeSchema.parse(req.query),
    ),
  );
});

export const listPublicKnowledge = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  ok(
    res,
    await knowledgePortalService.list(
      {
        kind: "public",
        tenantId: requireTenantId(req),
      },
      listPublishedKnowledgeSchema.parse(req.query),
    ),
  );
});

export const getPublicKnowledge = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  const { id } = communicationIdParamsSchema.parse(req.params);
  ok(
    res,
    await knowledgePortalService.get(
      {
        kind: "public",
        tenantId: requireTenantId(req),
      },
      id,
      listPublishedKnowledgeSchema.parse(req.query),
    ),
  );
});
