import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

/**
 * Removes read permissions for operational domains that are disabled for the
 * workspace. Resolved role permissions can outlive a module configuration
 * change, so AI context builders must apply this feature boundary explicitly.
 */
export const scopeOperationalAccessToEnabledModules = (
  access: ResolvedWorkspaceAccess,
  modules: Record<string, unknown>,
): ResolvedWorkspaceAccess => {
  const disabledPermissions = new Set<string>([
    ...(modules[TENANT_MODULE.BOOKINGS] === true
      ? []
      : [WORKSPACE_PERMISSION.BOOKINGS_VIEW]),
    ...(modules[TENANT_MODULE.CUSTOMERS] === true
      ? []
      : [WORKSPACE_PERMISSION.CUSTOMERS_VIEW]),
    ...(modules[TENANT_MODULE.STAFF_TASKS] === true
      ? []
      : [
          WORKSPACE_PERMISSION.TASKS_VIEW,
          WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
          WORKSPACE_PERMISSION.PLANNING_MANAGE,
        ]),
    ...(modules[TENANT_MODULE.INVENTORY] === true
      ? []
      : [WORKSPACE_PERMISSION.INVENTORY_VIEW]),
    ...(modules[TENANT_MODULE.PAYMENTS] === true
      ? []
      : [WORKSPACE_PERMISSION.ORDERS_VIEW]),
    ...(modules[TENANT_MODULE.COMMUNICATIONS] === true
      ? []
      : [WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW]),
  ]);

  return {
    ...access,
    permissions: access.permissions.filter(
      (permission) => !disabledPermissions.has(permission),
    ),
  };
};

export default scopeOperationalAccessToEnabledModules;
