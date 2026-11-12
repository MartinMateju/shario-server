import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { membershipPlanService } from "../services/membership-plan.service.js";
import {
  createMembershipPlanSchema,
  duplicateMembershipPlanSchema,
  listMembershipPlansSchema,
  membershipIdParamsSchema,
  publicMembershipCatalogQuerySchema,
  publicTenantMembershipParamsSchema,
  updateMembershipPlanSchema,
} from "../membership.validators.js";

const allowedLocations = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

export const getMembershipPlans = asyncHandler(async (req: Request, res: Response) => {
  const result = await membershipPlanService.list(
    requireTenantId(req),
    listMembershipPlansSchema.parse(req.query),
    allowedLocations(req),
  );
  res.json(result);
});

export const getMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const plan = await membershipPlanService.get(requireTenantId(req), id, allowedLocations(req));
  res.json({ plan });
});

export const createMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await membershipPlanService.create(
    requireTenantId(req),
    createMembershipPlanSchema.parse(req.body),
    allowedLocations(req),
    getAuthenticatedUserId(req),
  );
  res.status(201).json({ plan });
});

export const updateMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const plan = await membershipPlanService.update(
    requireTenantId(req),
    updateMembershipPlanSchema.parse({ ...req.body, id }),
    allowedLocations(req),
    getAuthenticatedUserId(req),
  );
  res.json({ plan });
});

export const publishMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const plan = await membershipPlanService.publish(
    requireTenantId(req), id, allowedLocations(req), getAuthenticatedUserId(req),
  );
  res.json({ plan });
});

export const archiveMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const plan = await membershipPlanService.archive(
    requireTenantId(req), id, allowedLocations(req), getAuthenticatedUserId(req),
  );
  res.json({ plan });
});

export const duplicateMembershipPlan = asyncHandler(async (req: Request, res: Response) => {
  const { id } = membershipIdParamsSchema.parse(req.params);
  const input = duplicateMembershipPlanSchema.parse(req.body ?? {});
  const plan = await membershipPlanService.duplicate(
    requireTenantId(req), id, input.name, allowedLocations(req), getAuthenticatedUserId(req),
  );
  res.status(201).json({ plan });
});

export const getPublicMembershipCatalog = asyncHandler(async (req: Request, res: Response) => {
  const { tenantSlug } = publicTenantMembershipParamsSchema.parse(req.params);
  const { locationId } = publicMembershipCatalogQuerySchema.parse(req.query);
  // Unpublishing must revoke catalog visibility on the next request.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json(await membershipPlanService.publicCatalog(tenantSlug, locationId));
});

export const getCustomerMembershipCatalog = asyncHandler(async (req: Request, res: Response) => {
  const { locationId } = publicMembershipCatalogQuerySchema.parse(req.query);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", "Authorization");
  res.json(await membershipPlanService.customerCatalog(requireTenantId(req), locationId));
});

// Legacy name kept for integrations that used DELETE as disable/archive.
export const deleteMembershipPlan = archiveMembershipPlan;
