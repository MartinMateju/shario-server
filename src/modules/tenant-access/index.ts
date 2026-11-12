export {
  ALL_WORKSPACE_PERMISSIONS,
  TENANT_PERMISSION,
  WORKSPACE_PERMISSION,
  WORKSPACE_PERMISSION_CATALOG,
  type WorkspacePermission,
} from "./tenant-access.permissions.js";
export {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
  type WorkspaceRole,
} from "./tenant-access.constants.js";
export {
  requireAnyPermission,
  requireLocationAccess,
  requirePermission,
  requireWorkspaceAccess,
  getResolvedWorkspaceAccess,
  type WorkspaceLocationIdResolver,
} from "./tenant-access.middleware.js";
export {
  canAccessWorkspaceLocation,
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
  serializeWorkspaceAccess,
} from "./services/authorization.service.js";
export {
  assertCanAccessAllWorkspaceLocations,
  assertAnyLocationWithinWorkspaceScope,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationIdsExist,
  assertTenantLocationsWithinWorkspaceScope,
  getEffectiveLocationFilter,
  type AllowedWorkspaceLocationIds,
} from "./services/location-scope.service.js";
export {
  createOwnerMembership,
  ensureLegacyWorkspaceMembershipForUser,
} from "./services/team.service.js";
export { tenantAccessRouter } from "./routes/tenant-access.routes.js";
export type {
  ResolvedWorkspaceAccess,
  WorkspaceAccessRequest,
} from "./tenant-access.types.js";
