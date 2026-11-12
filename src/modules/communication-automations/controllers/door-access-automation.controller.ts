import { z } from "zod";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import {
  getDoorAccessAutomation,
  updateDoorAccessAutomation,
} from "@/modules/access-codes/services/door-access-automation.service.js";

const inputSchema = z
  .object({
    locationId: z.string().regex(/^[a-f\d]{24}$/i),
    enabled: z.boolean(),
  })
  .strict();
export const readDoorAccessAutomation = asyncHandler(async (req, res) => {
  res.json(
    await getDoorAccessAutomation(
      requireTenantId(req),
      getAllowedWorkspaceLocationIds(
        getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
      ),
    ),
  );
});
export const patchDoorAccessAutomation = asyncHandler(async (req, res) => {
  const input = inputSchema.parse(req.body);
  res.json(
    await updateDoorAccessAutomation(
      requireTenantId(req),
      input.locationId,
      input.enabled,
      getAllowedWorkspaceLocationIds(
        getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
      ),
    ),
  );
});
