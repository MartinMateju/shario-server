export const TENANT_ROLE = {
  OWNER: "owner",
  ADMIN: "admin",
  STAFF: "staff",
  CUSTOMER: "customer",
} as const;

export type TenantRole = (typeof TENANT_ROLE)[keyof typeof TENANT_ROLE];

export const PLATFORM_ROLE = {
  NONE: "none",
  SUPER_ADMIN: "super_admin",
  SUPPORT: "support",
  DEVELOPER: "developer",
} as const;

export type PlatformRole = (typeof PLATFORM_ROLE)[keyof typeof PLATFORM_ROLE];

export const LEGACY_ROLE = {
  CUSTOMER: "1023e",
  MODERATOR: "2124o",
  ADMIN: "9092k",
} as const;

export type LegacyRole = (typeof LEGACY_ROLE)[keyof typeof LEGACY_ROLE];

export const USER_SELECT_SAFE =
  "-password -refreshToken -sessionVersion -emailToken -platformRole -roles -importMetadata -__v" as const;

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_MIN_LENGTH = 8;

export const USER_SORT_FIELDS = {
  CUSTOM_ID: "customId",
  FIRSTNAME: "firstname",
  LASTNAME: "lastname",
  EMAIL: "email",
  CREDITS: "credits",
  CREATED_AT: "createdAt",
} as const;
