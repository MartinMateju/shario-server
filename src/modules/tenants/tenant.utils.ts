import { Types } from "mongoose";

import type { Request } from "express";
import { unauthorized, badRequest } from "@/shared/http/httpErrors.js";

import { PLATFORM_HOSTS } from "./tenant.constants.js";
import { getCurrentPlanVersion, getPlanConfig } from "./tenant.plan.js";
import { reconcileTenantPlanModules } from "./tenant-workspace-modules.js";
import type {
  TenantDocument,
  TenantPlan,
} from "./tenant.types.js";

type TenantFilter = {
  tenant: string;
};

export const withTenant = <
  TFilter extends Record<string, unknown>,
>(
  req: Request,
  filter: TFilter = {} as TFilter,
): TFilter & TenantFilter => {
  return {
    ...filter,
    tenant: requireTenantId(req),
  };
};

/**
 * Converts an optional tenant identifier to a validated string.
 *
 * Returns null when no identifier is provided.
 */
export const normalizeTenantId = (
  value: unknown,
): string | null => {
  if (!value) {
    return null;
  }

  const tenantId = String(value).trim();

  if (!tenantId) {
    return null;
  }

  if (!Types.ObjectId.isValid(tenantId)) {
    badRequest("Invalid tenant id.");
  }

  return tenantId;
};

export const normalizeHost = (host: unknown): string => {
  const value = typeof host === "string" ? host.trim().toLowerCase() : "";

  if (!value) return "";

  const withoutProtocol = value.replace(/^https?:\/\//, "");
  const hostname = withoutProtocol.split("/")[0];

  if (hostname.startsWith("[")) {
    const closingBracket = hostname.indexOf("]");
    return closingBracket >= 0
      ? hostname.slice(1, closingBracket)
      : hostname.replace(/^\[|\]$/g, "");
  }

  return hostname.split(":")[0];
};

export const isPlatformHost = (host: unknown): boolean => {
  const hostname = normalizeHost(host);

  return !hostname || PLATFORM_HOSTS.has(hostname);
};

/**
 * Applies the selected plan configuration to a tenant document.
 */
export const applyPlanToTenant = <T extends TenantDocument>(
  tenant: T,
  plan: TenantPlan,
  planVersion: number = getCurrentPlanVersion(plan),
): T => {
  const config = getPlanConfig(plan, planVersion);
  reconcileTenantPlanModules(tenant, plan, config.version);
  tenant.limits = config.limits;

  return tenant;
};

/**
 * Returns a valid tenant ID from the authenticated user's access token.
 */
export const requireTenantId = (
  req: Request,
): string => {
  const tenantRequest = req as Request & {
    tenantId?: unknown;
    userInfo?: {
      tenant?: unknown;
      tenantId?: unknown;
    };
  };
  const tenantId = String(
    tenantRequest.userInfo?.tenant ??
      tenantRequest.userInfo?.tenantId ??
      tenantRequest.tenantId ??
      "",
  ).trim();

  if (!tenantId) {
    unauthorized(
      "Authenticated tenant is missing from the access token.",
    );
  }

  if (!Types.ObjectId.isValid(tenantId)) {
    unauthorized(
      "The access token contains an invalid tenant identifier.",
    );
  }

  return tenantId;
};

/**
 * Backwards-compatible alias.
 *
 * Prefer requireTenantId() when the authenticated tenant is mandatory.
 */
export const getTenantIdFromRequest = requireTenantId;
