import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import {
  badRequest,
  forbidden,
  notFound,
  AppError,
  unauthorized,
} from "../../../shared/http/httpErrors.js";
import { getTenantBySlug } from "@/modules/tenants/services/tenant.service.js";
import { serializeWorkspaceAccess } from "@/modules/tenant-access/index.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { deriveCustomerTenantCapabilities } from "@/modules/tenants/tenant-customer-capabilities.js";
import { getTenantCustomerCapabilities } from "@/modules/tenants/customer-piece-access.service.js";
import { findSubscriptionByTenant } from "@/modules/tenant-subscription/tenant-subscription.repository.js";
import { isPlatformBillingCurrency } from "@/shared/money/currency.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";

import {
  AUTH_CONTEXT,
  CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_NAME,
  type AuthContext,
} from "../auth.constants.js";
import type { AuthTenantForToken } from "../auth.types.js";
import {
  getRefreshCookieCleanupOptions,
  getRefreshCookieOptions,
  requiresFirstPartyRefreshProxy,
} from "../auth.utils.js";
import {
  resolveAuthRequestContext,
  type AuthRequestContext,
} from "../auth-first-party-proxy.js";
import {
  consumeSessionHandoff,
  createSessionHandoff,
  isSessionHandoffConfigured,
} from "../auth-session-handoff.js";
import {
  assertRefreshTokenOrigin,
  loginCustomerUser,
  loginUser,
  logoutUser,
  refreshAccessToken,
  refreshCustomerAccessToken,
} from "../services/auth.service.js";
import { loginSchema, validateBody } from "../auth.validators.js";
import { assertTenantAuthOrigin } from "../auth-origin.js";
import { normalizeRolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

type TenantForResponse = AuthTenantForToken & {
  onboarding?: {
    completed?: boolean;
    currentStep?: number;
  };
};

const toId = (value: unknown): string => String(value ?? "");

const serializeUser = (
  user: any,
  tenant: AuthTenantForToken,
  authContext: AuthContext,
) => ({
  id: toId(user._id || user.id),
  authContext,
  firstname: user.firstname,
  lastname: user.lastname,
  email: user.email,
  customerDefaultLanguage: normalizeRolloutEligibleAppLocale(
    user.customerDefaultLanguage,
  ),
  customId: user.customId,
  memberNumber:
    Number.isSafeInteger(user.memberNumber) && user.memberNumber > 0
      ? user.memberNumber
      : null,
  tenant: toId(tenant._id || tenant.id || user.tenant),
  tenantRole:
    authContext === AUTH_CONTEXT.CUSTOMER ? "customer" : user.tenantRole,
  platformRole:
    authContext === AUTH_CONTEXT.CUSTOMER
      ? "none"
      : user.platformRole || "none",
  isEmailVerified: user.isEmailVerified === true,
});

export const serializeAuthTenant = (tenant: TenantForResponse) => ({
  id: toId(tenant._id || tenant.id),
  name: tenant.name,
  slug: tenant.slug,
  plan: tenant.plan,
  planVersion: tenant.planVersion,
  modules: tenant.modules,
  customerCapabilities: deriveCustomerTenantCapabilities(tenant),
  limits: tenant.limits,
  settings: tenant.settings,
  publicSite: serializeTenantPublicSite({
    name: String(tenant.name || "Studio"),
    publicSite: tenant.publicSite,
  }),
  onboarding: {
    completed: tenant.onboarding?.completed === true,
    currentStep: tenant.onboarding?.currentStep ?? 1,
  },
});

export const serializeAuthSessionTenant = async (
  tenant: TenantForResponse,
  authContext: AuthContext,
) => {
  const snapshot = serializeAuthTenant(tenant);
  snapshot.customerCapabilities = await getTenantCustomerCapabilities(tenant);
  // Customer sessions only need the studio's operational settings. The SaaS
  // subscription belongs to the workspace and is never queried for customers.
  if (authContext !== AUTH_CONTEXT.WORKSPACE) return snapshot;

  const subscription = await findSubscriptionByTenant(snapshot.id);
  const billingCurrency = subscription?.billingCurrency;
  const capabilities = Object.values(TENANT_PLAN).includes(
    tenant.plan as TenantPlan,
  )
    ? getPlanConfig(tenant.plan as TenantPlan, tenant.planVersion ?? 1)
        .capabilities
    : undefined;
  return {
    ...snapshot,
    ...(capabilities ? { capabilities } : {}),
    ...(isPlatformBillingCurrency(billingCurrency) ? { billingCurrency } : {}),
  };
};

const clearRefreshCookie = (
  res: Response,
  cookieName: string,
  context: AuthRequestContext,
): void => {
  for (const options of getRefreshCookieCleanupOptions(context.origin, {
    firstPartyProxy: context.firstPartyProxy,
  })) {
    res.clearCookie(cookieName, options);
  }
};

const setRefreshCookie = (
  res: Response,
  cookieName: string,
  refreshToken: string,
  context: AuthRequestContext,
): void => {
  res.cookie(
    cookieName,
    refreshToken,
    getRefreshCookieOptions(context.origin, {
      firstPartyProxy: context.firstPartyProxy,
    }),
  );
};

type RefreshSessionDelivery =
  | {
      mode: "first-party-cookie";
    }
  | {
      mode: "first-party-handoff";
      handoff: string;
    };

const requiresDirectHandoff = (context: AuthRequestContext): boolean =>
  !context.firstPartyProxy &&
  Boolean(context.origin) &&
  requiresFirstPartyRefreshProxy(context.origin);

const assertRefreshDeliveryAvailable = (context: AuthRequestContext): void => {
  if (requiresDirectHandoff(context) && !isSessionHandoffConfigured()) {
    throw new AppError({
      statusCode: 503,
      message: "First-party custom-domain authentication is not configured.",
      code: "AUTH_FIRST_PARTY_PROXY_NOT_CONFIGURED",
    });
  }
};

const assertStatefulCustomDomainRequestIsProxied = (
  context: AuthRequestContext,
): void => {
  if (requiresDirectHandoff(context)) {
    forbidden({
      message:
        "Custom-domain refresh and logout requests must use the first-party authentication proxy.",
      code: "AUTH_FIRST_PARTY_PROXY_REQUIRED",
    });
  }
};

const deliverRefreshSession = ({
  res,
  cookieName,
  refreshToken,
  authContext,
  context,
}: {
  res: Response;
  cookieName: string;
  refreshToken: string;
  authContext: AuthContext;
  context: AuthRequestContext;
}): RefreshSessionDelivery => {
  clearRefreshCookie(res, cookieName, context);

  if (requiresDirectHandoff(context)) {
    return {
      mode: "first-party-handoff",
      handoff: createSessionHandoff({
        refreshToken,
        authContext,
        origin: context.origin,
      }),
    };
  }

  setRefreshCookie(res, cookieName, refreshToken, context);

  return {
    mode: "first-party-cookie",
  };
};

const sendSession = async (
  res: Response,
  result: {
    accessToken: string;
    user: any;
    tenant: any;
    workspaceAccess: any;
    authContext: AuthContext;
  },
  refreshSession: RefreshSessionDelivery,
): Promise<void> => {
  const tenant = await serializeAuthSessionTenant(
    result.tenant,
    result.authContext,
  );
  res.status(200).json({
    accessToken: result.accessToken,
    authContext: result.authContext,
    user: serializeUser(result.user, result.tenant, result.authContext),
    tenant,
    workspaceAccess:
      result.authContext === AUTH_CONTEXT.WORKSPACE && result.workspaceAccess
        ? serializeWorkspaceAccess(result.workspaceAccess)
        : null,
    refreshSession,
  });
};

const loadLoginTenant = async (tenantSlug: string, origin?: string) => {
  const tenant = await getTenantBySlug(tenantSlug);

  if (!tenant) {
    notFound("We could not find this workspace.");
  }

  assertTenantAuthOrigin({ origin, tenant });
  return tenant;
};

/** Backwards-compatible login that resolves workspace vs pure-customer mode. */
export const login = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { tenantSlug, email, password } = validateBody(loginSchema, req.body);
    const requestContext = await resolveAuthRequestContext(req);
    assertRefreshDeliveryAvailable(requestContext);
    const tenant = await loadLoginTenant(tenantSlug, requestContext.origin);
    const oldWorkspaceToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const oldCustomerToken = req.cookies?.[
      CUSTOMER_REFRESH_TOKEN_COOKIE_NAME
    ] as string | undefined;

    const result = await loginUser({
      input: { email, password },
      tenant,
      oldRefreshToken: oldWorkspaceToken,
      oldCustomerRefreshToken: oldCustomerToken,
    });
    const cookieName =
      result.authContext === AUTH_CONTEXT.CUSTOMER
        ? CUSTOMER_REFRESH_TOKEN_COOKIE_NAME
        : REFRESH_TOKEN_COOKIE_NAME;

    const refreshSession = deliverRefreshSession({
      res,
      cookieName,
      refreshToken: result.refreshToken,
      authContext: result.authContext,
      context: requestContext,
    });

    if (result.migratedLegacyCustomerSession) {
      clearRefreshCookie(res, REFRESH_TOKEN_COOKIE_NAME, requestContext);
    }

    await sendSession(res, result, refreshSession);
  },
);

/** Explicit customer mode, including for an owner/staff account. */
export const loginCustomer = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { tenantSlug, email, password } = validateBody(loginSchema, req.body);
    const requestContext = await resolveAuthRequestContext(req);
    assertRefreshDeliveryAvailable(requestContext);
    const tenant = await loadLoginTenant(tenantSlug, requestContext.origin);
    const oldCustomerToken = req.cookies?.[
      CUSTOMER_REFRESH_TOKEN_COOKIE_NAME
    ] as string | undefined;

    const result = await loginCustomerUser({
      input: { email, password },
      tenant,
      oldRefreshToken: oldCustomerToken,
    });

    const refreshSession = deliverRefreshSession({
      res,
      cookieName: CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
      refreshToken: result.refreshToken,
      authContext: result.authContext,
      context: requestContext,
    });
    await sendSession(res, result, refreshSession);
  },
);

export const logout = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const requestContext = await resolveAuthRequestContext(req);
    assertStatefulCustomDomainRequestIsProxied(requestContext);

    try {
      await assertRefreshTokenOrigin(refreshToken, requestContext.origin);
      await logoutUser(refreshToken);
    } finally {
      clearRefreshCookie(res, REFRESH_TOKEN_COOKIE_NAME, requestContext);
    }

    res.status(200).json({ message: "Logged out successfully" });
  },
);

export const logoutCustomer = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const refreshToken = req.cookies?.[CUSTOMER_REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const requestContext = await resolveAuthRequestContext(req);
    assertStatefulCustomDomainRequestIsProxied(requestContext);

    try {
      await assertRefreshTokenOrigin(refreshToken, requestContext.origin);
      await logoutUser(refreshToken, AUTH_CONTEXT.CUSTOMER);
    } finally {
      clearRefreshCookie(
        res,
        CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
        requestContext,
      );
    }

    res.status(200).json({ message: "Logged out successfully" });
  },
);

export const refresh = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const requestContext = await resolveAuthRequestContext(req);
    assertStatefulCustomDomainRequestIsProxied(requestContext);
    const result = await refreshAccessToken(
      refreshToken,
      requestContext.origin,
    );

    const refreshSession = deliverRefreshSession({
      res,
      cookieName: REFRESH_TOKEN_COOKIE_NAME,
      refreshToken: result.refreshToken,
      authContext: result.authContext,
      context: requestContext,
    });
    await sendSession(res, result, refreshSession);
  },
);

export const refreshCustomer = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const customerToken = req.cookies?.[CUSTOMER_REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const legacyToken = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME] as
      string | undefined;
    const useLegacy = !customerToken && Boolean(legacyToken);
    const requestContext = await resolveAuthRequestContext(req);
    assertStatefulCustomDomainRequestIsProxied(requestContext);
    const result = await refreshCustomerAccessToken(
      customerToken ?? legacyToken,
      requestContext.origin,
      { allowLegacyCustomer: useLegacy },
    );

    const refreshSession = deliverRefreshSession({
      res,
      cookieName: CUSTOMER_REFRESH_TOKEN_COOKIE_NAME,
      refreshToken: result.refreshToken,
      authContext: result.authContext,
      context: requestContext,
    });

    if (result.migratedLegacyCustomerSession) {
      clearRefreshCookie(res, REFRESH_TOKEN_COOKIE_NAME, requestContext);
    }

    await sendSession(res, result, refreshSession);
  },
);

/**
 * Exchanges a short-lived sealed credential through the trusted same-origin
 * frontend proxy. The embedded refresh token is immediately rotated, so a
 * replay (including a concurrent replay) loses the repository compare-and-swap.
 */
const exchangeSessionHandoffForContext = (expectedContext: AuthContext) =>
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const requestContext = await resolveAuthRequestContext(req);

    if (!requestContext.firstPartyProxy || !requestContext.origin) {
      forbidden({
        message:
          "Session handoff requires the first-party authentication proxy.",
        code: "AUTH_SESSION_HANDOFF_PROXY_REQUIRED",
      });
    }

    const handoff =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>).sessionHandoff
        : undefined;

    if (typeof handoff !== "string" || handoff.length > 4_096) {
      badRequest({
        message: "A session handoff is required.",
        code: "AUTH_SESSION_HANDOFF_REQUIRED",
      });
    }

    const payload = consumeSessionHandoff(handoff as string);

    if (payload.origin !== requestContext.origin) {
      forbidden({
        message: "The session handoff belongs to another origin.",
        code: "AUTH_SESSION_HANDOFF_ORIGIN_MISMATCH",
      });
    }

    if (payload.authContext !== expectedContext) {
      unauthorized({
        message:
          "The session handoff belongs to another authentication context.",
        code: "AUTH_SESSION_HANDOFF_CONTEXT_MISMATCH",
      });
    }

    const result =
      expectedContext === AUTH_CONTEXT.CUSTOMER
        ? await refreshCustomerAccessToken(
            payload.refreshToken,
            requestContext.origin,
          )
        : await refreshAccessToken(payload.refreshToken, requestContext.origin);
    const cookieName =
      result.authContext === AUTH_CONTEXT.CUSTOMER
        ? CUSTOMER_REFRESH_TOKEN_COOKIE_NAME
        : REFRESH_TOKEN_COOKIE_NAME;

    clearRefreshCookie(res, cookieName, requestContext);
    setRefreshCookie(res, cookieName, result.refreshToken, requestContext);
    await sendSession(res, result, { mode: "first-party-cookie" });
  });

export const exchangeWorkspaceSessionHandoff = exchangeSessionHandoffForContext(
  AUTH_CONTEXT.WORKSPACE,
);

export const exchangeCustomerSessionHandoff = exchangeSessionHandoffForContext(
  AUTH_CONTEXT.CUSTOMER,
);
