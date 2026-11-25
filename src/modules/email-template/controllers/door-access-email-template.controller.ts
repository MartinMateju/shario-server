import { z } from "zod";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import {
  listDoorAccessEmailTemplates,
  resetDoorAccessEmailTemplate,
  saveDoorAccessEmailTemplate,
} from "@/modules/access-codes/services/door-access-email-template.service.js";

const paramsSchema = z.object({
  locationId: z.string().regex(/^[a-f\d]{24}$/i),
});
const scope = (req: WorkspaceAccessRequest) =>
  getAllowedWorkspaceLocationIds(getResolvedWorkspaceAccess(req));

export const getDoorAccessEmailTemplates = asyncHandler(async (req, res) => {
  res.json(
    await listDoorAccessEmailTemplates(requireTenantId(req), scope(req)),
  );
});

export const patchDoorAccessEmailTemplate = asyncHandler(async (req, res) => {
  const { locationId } = paramsSchema.parse(req.params);
  res.json(
    await saveDoorAccessEmailTemplate(
      requireTenantId(req),
      locationId,
      req.body,
      scope(req),
    ),
  );
});

export const deleteDoorAccessEmailTemplate = asyncHandler(async (req, res) => {
  const { locationId } = paramsSchema.parse(req.params);
  res.json(
    await resetDoorAccessEmailTemplate(
      requireTenantId(req),
      locationId,
      scope(req),
    ),
  );
});
