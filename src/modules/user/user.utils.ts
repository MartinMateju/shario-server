import bcrypt from "bcryptjs";

import {
  LEGACY_ROLE,
  PLATFORM_ROLE,
  TENANT_ROLE,
  type LegacyRole,
  type PlatformRole,
  type TenantRole,
} from "./user.constants.js";

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export const escapeRegex = (value = ""): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const hashData = async (
  data: string,
  saltRounds = 12,
): Promise<string> => bcrypt.hash(data, saltRounds);

export const isTenantAdminRole = (role?: TenantRole): boolean =>
  role === TENANT_ROLE.OWNER || role === TENANT_ROLE.ADMIN;

export const isTenantStaffRole = (role?: TenantRole): boolean =>
  role === TENANT_ROLE.STAFF;

export const isPlatformAdminRole = (role?: PlatformRole): boolean =>
  role === PLATFORM_ROLE.SUPER_ADMIN || role === PLATFORM_ROLE.DEVELOPER;

export const legacyRoleToTenantRole = (
  roles: LegacyRole[] = [],
): TenantRole => {
  if (roles.includes(LEGACY_ROLE.ADMIN)) return TENANT_ROLE.ADMIN;
  if (roles.includes(LEGACY_ROLE.MODERATOR)) return TENANT_ROLE.STAFF;
  return TENANT_ROLE.CUSTOMER;
};
