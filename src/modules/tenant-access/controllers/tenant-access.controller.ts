import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import type { Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  WORKSPACE_PERMISSION_CATALOG,
} from "../tenant-access.permissions.js";
import { listBuiltInRoles } from "../tenant-access.roles.js";
import {
  getResolvedWorkspaceAccess,
} from "../tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "../tenant-access.types.js";
import {
  createCustomRoleSchema,
  createTeamMemberSchema,
  listTeamMembersSchema,
  membershipIdParamsSchema,
  parseTenantAccessInput,
  roleIdParamsSchema,
  updateCustomRoleSchema,
  updateTeamMemberSchema,
  workspacePreferencesInputSchema,
} from "../tenant-access.validators.js";
import { serializeWorkspaceAccess } from "../services/authorization.service.js";
import {
  createWorkspaceCustomRole,
  deleteWorkspaceCustomRole,
  listWorkspaceRoles,
  updateWorkspaceCustomRole,
} from "../services/role.service.js";
import {
  addExistingTenantUserToTeam,
  getTeamMember,
  listTeamMembers,
  revokeTeamMember,
  updateCurrentWorkspacePreferences,
  updateTeamMember,
} from "../services/team.service.js";

const buildActorContext = (req: WorkspaceAccessRequest) => ({
  tenantId: requireTenantId(req),
  actorUserId: getAuthenticatedUserId(req),
  actorAccess: getResolvedWorkspaceAccess(req),
});

export const getCurrentWorkspaceAccess = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    res.status(200).json({
      workspaceAccess: serializeWorkspaceAccess(
        getResolvedWorkspaceAccess(req),
      ),
    });
  },
);

export const updateCurrentWorkspacePreferencesController = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const input = parseTenantAccessInput(
      workspacePreferencesInputSchema,
      req.body,
    );
    const workspaceAccess = await updateCurrentWorkspacePreferences({
      tenantId: context.tenantId,
      userId: context.actorUserId,
      input,
    });

    res.status(200).json({ workspaceAccess });
  },
);

export const getWorkspacePermissionCatalog = asyncHandler(
  async (_req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    res.status(200).json({
      permissions: WORKSPACE_PERMISSION_CATALOG.filter(
        ({ category }) => category !== "invoices" || isNativeInvoicingEnabled(),
      ),
      builtInRoles: listBuiltInRoles().map((role) => ({
        roleKey: role.key,
        roleName: role.name ?? role.key,
        permissions: role.permissions.filter(
          (permission) => !permission.startsWith("invoices.") || isNativeInvoicingEnabled(),
        ),
      })),
    });
  },
);

export const listCurrentTenantTeam = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const input = parseTenantAccessInput(listTeamMembersSchema, req.query);
    const result = await listTeamMembers({
      tenantId: requireTenantId(req),
      input,
    });

    res.status(200).json(result);
  },
);

export const addCurrentTenantTeamMember = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const input = parseTenantAccessInput(createTeamMemberSchema, req.body);
    const membership = await addExistingTenantUserToTeam({
      ...context,
      input,
    });

    res.status(201).json({ membership });
  },
);

export const getCurrentTenantTeamMember = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const { membershipId } = parseTenantAccessInput(
      membershipIdParamsSchema,
      req.params,
    );
    const membership = await getTeamMember({
      tenantId: requireTenantId(req),
      membershipId,
    });

    res.status(200).json({ membership });
  },
);

export const updateCurrentTenantTeamMember = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const { membershipId } = parseTenantAccessInput(
      membershipIdParamsSchema,
      req.params,
    );
    const input = parseTenantAccessInput(updateTeamMemberSchema, req.body);
    const membership = await updateTeamMember({
      ...context,
      membershipId,
      input,
    });

    res.status(200).json({ membership });
  },
);

export const deleteCurrentTenantTeamMember = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const { membershipId } = parseTenantAccessInput(
      membershipIdParamsSchema,
      req.params,
    );
    const membership = await revokeTeamMember({
      ...context,
      membershipId,
    });

    res.status(200).json({ membership });
  },
);

export const listCurrentTenantRoles = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const result = await listWorkspaceRoles(requireTenantId(req));
    res.status(200).json(result);
  },
);

export const createCurrentTenantRole = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const input = parseTenantAccessInput(createCustomRoleSchema, req.body);
    const role = await createWorkspaceCustomRole({ ...context, input });

    res.status(201).json({ role });
  },
);

export const updateCurrentTenantRole = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const context = buildActorContext(req);
    const { roleId } = parseTenantAccessInput(roleIdParamsSchema, req.params);
    const input = parseTenantAccessInput(updateCustomRoleSchema, req.body);
    const role = await updateWorkspaceCustomRole({
      ...context,
      roleId,
      input,
    });

    res.status(200).json({ role });
  },
);

export const deleteCurrentTenantRole = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const { tenantId, actorUserId } = buildActorContext(req);
    const { roleId } = parseTenantAccessInput(roleIdParamsSchema, req.params);
    const result = await deleteWorkspaceCustomRole({
      tenantId,
      roleId,
      actorUserId,
    });

    res.status(200).json(result);
  },
);
