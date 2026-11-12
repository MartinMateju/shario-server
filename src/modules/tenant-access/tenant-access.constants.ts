import { APP_LOCALE } from "@/shared/i18n/locales.js";

export const WORKSPACE_ROLE = {
  OWNER: "owner",
  ADMIN: "admin",
  MANAGER: "manager",
  STAFF: "staff",
  ACCOUNTANT: "accountant",
  VIEWER: "viewer",
  CUSTOM: "custom",
} as const;

export type WorkspaceRole =
  (typeof WORKSPACE_ROLE)[keyof typeof WORKSPACE_ROLE];

export const BUILT_IN_WORKSPACE_ROLES = [
  WORKSPACE_ROLE.OWNER,
  WORKSPACE_ROLE.ADMIN,
  WORKSPACE_ROLE.MANAGER,
  WORKSPACE_ROLE.STAFF,
  WORKSPACE_ROLE.ACCOUNTANT,
  WORKSPACE_ROLE.VIEWER,
] as const;

export type BuiltInWorkspaceRole = (typeof BUILT_IN_WORKSPACE_ROLES)[number];

export const TENANT_MEMBERSHIP_STATUS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  REVOKED: "revoked",
} as const;

export type TenantMembershipStatus =
  (typeof TENANT_MEMBERSHIP_STATUS)[keyof typeof TENANT_MEMBERSHIP_STATUS];

export const LOCATION_ACCESS_MODE = {
  ALL: "all",
  SELECTED: "selected",
} as const;

export type LocationAccessMode =
  (typeof LOCATION_ACCESS_MODE)[keyof typeof LOCATION_ACCESS_MODE];

/**
 * How long a resolved workspace access result may be served from cache
 * before it's re-read from the database, and the key it's cached under.
 * Kept here (rather than alongside the middleware) so the write paths that
 * invalidate it (tenant-access.repository.ts) don't need to import the
 * middleware module.
 */
export const WORKSPACE_ACCESS_CACHE_TTL_SECONDS = Number(
  process.env.WORKSPACE_ACCESS_CACHE_TTL_SECONDS || 45,
);

export const workspaceAccessCacheKey = (
  tenantId: unknown,
  userId: unknown,
): string => `shario:workspace-access:${String(tenantId)}:${String(userId)}`;

export const WORKSPACE_CALENDAR_VIEW = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
} as const;

export type WorkspaceCalendarView =
  (typeof WORKSPACE_CALENDAR_VIEW)[keyof typeof WORKSPACE_CALENDAR_VIEW];

export const WORKSPACE_PREFERENCE_LANGUAGE = {
  EN: APP_LOCALE.EN,
  CS: APP_LOCALE.CS,
  DE: APP_LOCALE.DE,
  PL: APP_LOCALE.PL,
  SK: APP_LOCALE.SK,
  DA: APP_LOCALE.DA,
  FR: APP_LOCALE.FR,
  ES: APP_LOCALE.ES,
  IT: APP_LOCALE.IT,
  PT_PT: APP_LOCALE.PT_PT,
  SV: APP_LOCALE.SV,
  NB: APP_LOCALE.NB,
  FI: APP_LOCALE.FI,
  HU: APP_LOCALE.HU,
  EL: APP_LOCALE.EL,
  TR: APP_LOCALE.TR,
  NL: APP_LOCALE.NL,
  RO: APP_LOCALE.RO,
} as const;

export type WorkspacePreferenceLanguage =
  (typeof WORKSPACE_PREFERENCE_LANGUAGE)[keyof typeof WORKSPACE_PREFERENCE_LANGUAGE];

export const DEFAULT_WORKSPACE_CALENDAR_COLOR = "#74869a";
export const DEFAULT_WORKSPACE_LANDING_PAGE = "/app";
export const DEFAULT_TEAM_PAGE_SIZE = 50;
export const MAX_TEAM_PAGE_SIZE = 200;
