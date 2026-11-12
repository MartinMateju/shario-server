import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";

import {
  addCurrentTenantTeamMember,
  createCurrentTenantRole,
  deleteCurrentTenantRole,
  deleteCurrentTenantTeamMember,
  getCurrentTenantTeamMember,
  getCurrentWorkspaceAccess,
  getWorkspacePermissionCatalog,
  listCurrentTenantRoles,
  listCurrentTenantTeam,
  updateCurrentTenantRole,
  updateCurrentTenantTeamMember,
  updateCurrentWorkspacePreferencesController,
} from "../controllers/tenant-access.controller.js";
import {
  requirePermission,
  requireWorkspaceAccess,
} from "../tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "../tenant-access.permissions.js";
import { teamInvitationSendLimiter } from "../team-invitation.limiter.js";
import {
  createCurrentTeamInvitation,
  createCurrentTeamSignInInvitation,
  listCurrentTeamInvitations,
  resendCurrentTeamInvitation,
  revokeCurrentTeamInvitation,
} from "../controllers/team-invitation.controller.js";

export const tenantAccessRouter = Router();

tenantAccessRouter.use(verifyJWT);
tenantAccessRouter.use(requireWorkspaceAccess);

tenantAccessRouter.get("/me", getCurrentWorkspaceAccess);
tenantAccessRouter.patch(
  "/me/preferences",
  updateCurrentWorkspacePreferencesController,
);
tenantAccessRouter.get("/permissions", getWorkspacePermissionCatalog);

tenantAccessRouter
  .route("/invitations")
  .get(
    requirePermission(WORKSPACE_PERMISSION.TEAM_VIEW),
    listCurrentTeamInvitations,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
    teamInvitationSendLimiter,
    createCurrentTeamInvitation,
  );
tenantAccessRouter.post(
  "/invitations/:invitationId/resend",
  requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
  teamInvitationSendLimiter,
  resendCurrentTeamInvitation,
);
tenantAccessRouter.delete(
  "/invitations/:invitationId",
  requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
  revokeCurrentTeamInvitation,
);
tenantAccessRouter.post(
  "/team/:membershipId/invitation",
  requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
  teamInvitationSendLimiter,
  createCurrentTeamSignInInvitation,
);

tenantAccessRouter
  .route("/team")
  .get(requirePermission(WORKSPACE_PERMISSION.TEAM_VIEW), listCurrentTenantTeam)
  .post(
    requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
    addCurrentTenantTeamMember,
  );

tenantAccessRouter
  .route("/team/:membershipId")
  .get(
    requirePermission(WORKSPACE_PERMISSION.TEAM_VIEW),
    getCurrentTenantTeamMember,
  )
  .patch(
    requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
    updateCurrentTenantTeamMember,
  )
  .delete(
    requirePermission(WORKSPACE_PERMISSION.TEAM_MANAGE),
    deleteCurrentTenantTeamMember,
  );

tenantAccessRouter
  .route("/roles")
  .get(
    requirePermission(WORKSPACE_PERMISSION.ROLES_VIEW),
    listCurrentTenantRoles,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.ROLES_MANAGE),
    createCurrentTenantRole,
  );

tenantAccessRouter
  .route("/roles/:roleId")
  .patch(
    requirePermission(WORKSPACE_PERMISSION.ROLES_MANAGE),
    updateCurrentTenantRole,
  )
  .delete(
    requirePermission(WORKSPACE_PERMISSION.ROLES_MANAGE),
    deleteCurrentTenantRole,
  );

export default tenantAccessRouter;
