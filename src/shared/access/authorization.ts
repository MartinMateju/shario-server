import {
  PLATFORM_ROLE,
  TENANT_ROLE,
  type PlatformRole,
  type TenantRole,
} from "@/modules/user/user.constants.js";

export type AuthorizableUser = {
  tenantRole?: TenantRole | null;
  platformRole?: PlatformRole | null;
};

const PLATFORM_TENANT_BYPASS_ROLES: readonly PlatformRole[] = [
  PLATFORM_ROLE.SUPER_ADMIN,
  PLATFORM_ROLE.SUPPORT,
  PLATFORM_ROLE.DEVELOPER,
];

export const hasPlatformTenantBypass = (
  user: AuthorizableUser | null | undefined,
): boolean => {
  if (!user?.platformRole) return false;

  return PLATFORM_TENANT_BYPASS_ROLES.includes(user.platformRole);
};

export const hasTenantRole = (
  user: AuthorizableUser | null | undefined,
  ...roles: TenantRole[]
): boolean => {
  if (!user) return false;

  if (hasPlatformTenantBypass(user)) {
    return true;
  }

  if (!user.tenantRole) {
    return false;
  }

  return roles.includes(user.tenantRole);
};

export const isOwner = (
  user: AuthorizableUser | null | undefined,
): boolean => {
  return hasTenantRole(user, TENANT_ROLE.OWNER);
};

export const isAdmin = (
  user: AuthorizableUser | null | undefined,
): boolean => {
  return hasTenantRole(user, TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN);
};

export const isStaff = (
  user: AuthorizableUser | null | undefined,
): boolean => {
  return hasTenantRole(
    user,
    TENANT_ROLE.OWNER,
    TENANT_ROLE.ADMIN,
    TENANT_ROLE.STAFF,
  );
};

export const isCustomer = (
  user: AuthorizableUser | null | undefined,
): boolean => {
  return hasTenantRole(
    user,
    TENANT_ROLE.OWNER,
    TENANT_ROLE.ADMIN,
    TENANT_ROLE.STAFF,
    TENANT_ROLE.CUSTOMER,
  );
};

export const requireTenantRole = (
  user: AuthorizableUser | null | undefined,
  ...roles: TenantRole[]
): void => {
  if (!hasTenantRole(user, ...roles)) {
    throw new Error("Unauthorized");
  }
};