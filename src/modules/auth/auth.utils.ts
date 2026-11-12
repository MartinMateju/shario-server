import type { CookieOptions, Request } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import type {
  PlatformRole,
  TenantRole,
} from "@/modules/user/user.constants.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

import {
  ACCESS_TOKEN_EXPIRES_IN,
  AUTH_CONTEXT,
  COOKIE_DOMAINS,
  REFRESH_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_MAX_AGE_MS,
  type AuthContext,
} from "./auth.constants.js";
import type {
  AccessTokenPayload,
  AuthTenantForToken,
  AuthUserForToken,
  RefreshTokenPayload,
} from "./auth.types.js";

export type RequestUser = {
  _id?: string;
  id?: string;
  userId?: string;

  email?: string;
  firstname?: string;
  lastname?: string;
  name?: string;
  customId?: string;
  memberNumber?: number | null;

  tenant?: string;
  tenantRole?: TenantRole | null;
  platformRole?: PlatformRole | null;

  isAdmin?: boolean;
  isModerator?: boolean;
};

export type RequestWithUser = Request & {
  userInfo?: RequestUser;
  user?: RequestUser | string | null;
};

const isProduction = process.env.NODE_ENV === "production";

/*
|--------------------------------------------------------------------------
| Internal helpers
|--------------------------------------------------------------------------
*/

const toId = (value: unknown): string => {
  return String(value ?? "").trim();
};

const requireId = (value: unknown, label: string): string => {
  const id = toId(value);

  if (!id) {
    throw new Error(
      `${label} identifier is required to create an authentication token.`,
    );
  }

  return id;
};

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();

  if (!value) {
    throw new Error(`${key} environment variable is not defined.`);
  }

  return value;
};

const requireSessionVersion = (value: unknown): number => {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "User session version must be a non-negative safe integer.",
    );
  }

  return value;
};

const STORED_REFRESH_TOKEN_PREFIX = "sha256:";

/**
 * Refresh credentials are high-entropy signed JWTs, so a one-way SHA-256
 * digest is sufficient for equality lookups without retaining a replayable
 * bearer credential in MongoDB. The browser cookie remains unchanged.
 */
export const hashRefreshTokenForStorage = (refreshToken: string): string =>
  `${STORED_REFRESH_TOKEN_PREFIX}${crypto
    .createHash("sha256")
    .update(refreshToken, "utf8")
    .digest("hex")}`;

/**
 * Raw tokens are included temporarily so records written by older releases
 * remain usable after this release is deployed. Every successful rotation
 * replaces the legacy raw value with a digest. Deploy all API instances
 * together: an older binary cannot read digest-only records written by this
 * version.
 */
export const getRefreshTokenStorageCandidates = (
  refreshToken: string,
): string[] => [hashRefreshTokenForStorage(refreshToken), refreshToken];

/*
|--------------------------------------------------------------------------
| Normalization
|--------------------------------------------------------------------------
*/

export const normalizeEmail = (email: unknown): string => {
  return String(email ?? "")
    .trim()
    .toLowerCase();
};

const requireTokenEmail = (value: unknown): string => {
  const email = normalizeEmail(value);

  if (!email) {
    throw new Error(
      "User email is required to create an authentication token.",
    );
  }

  return email;
};

/*
|--------------------------------------------------------------------------
| Authenticated request helpers
|--------------------------------------------------------------------------
*/

export const isRequestUser = (user: unknown): user is RequestUser => {
  return user !== null && typeof user === "object";
};

export const getAuthenticatedUser = (
  req: RequestWithUser,
): RequestUser | null => {
  if (isRequestUser(req.userInfo)) {
    return req.userInfo;
  }

  if (isRequestUser(req.user)) {
    return req.user;
  }

  return null;
};

export const getAuthenticatedUserId = (req: RequestWithUser): string => {
  const user = getAuthenticatedUser(req);

  const id = user?.id ?? user?.userId ?? user?._id;

  if (!id) {
    unauthorized("Authenticated user is missing from request.");
  }

  return String(id);
};

export const getAuthenticatedUserEmail = (req: RequestWithUser): string => {
  const email = normalizeEmail(getAuthenticatedUser(req)?.email);

  if (!email) {
    unauthorized("Authenticated user email is missing from request.");
  }

  return email;
};

export const getAuthenticatedUserName = (req: RequestWithUser): string => {
  const user = getAuthenticatedUser(req);

  return (
    [user?.firstname, user?.lastname].filter(Boolean).join(" ").trim() ||
    user?.name ||
    user?.email ||
    "Unknown User"
  );
};

/*
|--------------------------------------------------------------------------
| Refresh-token cookie
|--------------------------------------------------------------------------
|
| Recommended development flow:
|
| shario.localhost:4310
|   -> api.shario.localhost:4311
|   -> example-space.shario.localhost:4310
|
| These hosts share the shario.localhost site, so the refresh cookie can use the
| normal local-development settings SameSite=Lax and Secure=false. Flat sibling
| hosts such as api.localhost and studio.localhost are separate browser sites
| and are retained only as a compatibility fallback.
|
| Production flow:
|
| shario.io
|   -> api.shario.io
|   -> studio-grohovka.shario.io
|
| These are same-site, so the production Shario cookie uses SameSite=Lax.
|
| Paid custom domains are cross-site with api.shario.io and therefore require
| SameSite=None.
|
*/

const getOriginHostname = (origin?: string | null): string => {
  if (!origin) {
    return "";
  }

  try {
    return new URL(origin).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
};

const isLocalDevelopmentOrigin = (origin?: string | null): boolean => {
  if (isProduction) {
    return false;
  }

  const hostname = getOriginHostname(origin);

  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1"
  );
};

const normalizeDevelopmentHostname = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");

const getDevelopmentRootDomains = (): Set<string> =>
  new Set(
    [
      normalizeDevelopmentHostname(process.env.DEVELOPMENT_ROOT_DOMAIN),

      /*
       * `localhost` was the historical default in .env.example, while the
       * actual first-party topology uses:
       *
       *   shario.localhost
       *   api.shario.localhost
       *   <tenant>.shario.localhost
       *
       * Always recognizing the product's loopback root keeps old local env
       * files working. This applies only outside production and does not add a
       * cookie Domain attribute or trust an arbitrary tenant origin.
       */
      "shario.localhost",
    ].filter(Boolean),
  );

const isSharedDevelopmentSite = (origin?: string | null): boolean => {
  if (isProduction) {
    return false;
  }

  const hostname = getOriginHostname(origin);

  /*
   * A single-label root such as "localhost" cannot provide a shared
   * registrable site to api.localhost and studio.localhost. A nested root such
   * as "shario.localhost" can: all of its subdomains are same-site.
   */
  if (!hostname) {
    return false;
  }

  return [...getDevelopmentRootDomains()].some(
    (rootDomain) =>
      rootDomain.includes(".") &&
      rootDomain !== "localhost" &&
      (hostname === rootDomain || hostname.endsWith(`.${rootDomain}`)),
  );
};

const isSharioOrigin = (origin?: string | null): boolean => {
  /*
   * Requests without an Origin are treated as first-party.
   * Browser requests from the frontend will include Origin.
   */
  if (!origin) {
    return true;
  }

  const hostname = getOriginHostname(origin);

  return hostname === "shario.io" || hostname.endsWith(".shario.io");
};

export type RefreshCookieTransportOptions = {
  firstPartyProxy?: boolean;
};

export const requiresFirstPartyRefreshProxy = (
  origin?: string | null,
): boolean => {
  const isLocalDevelopment = isLocalDevelopmentOrigin(origin);
  const isSharedDevelopment = isSharedDevelopmentSite(origin);
  const isProductionCustomDomain = isProduction && !isSharioOrigin(origin);

  return (
    (isLocalDevelopment && !isSharedDevelopment) || isProductionCustomDomain
  );
};

const getBaseRefreshCookieOptions = (
  origin?: string | null,
  options: RefreshCookieTransportOptions = {},
): CookieOptions => {
  const needsCrossSiteCookie =
    options.firstPartyProxy !== true &&
    requiresFirstPartyRefreshProxy(origin);

  return {
    httpOnly: true,

    /*
     * SameSite=None requires Secure.
     *
     * Production is always secure. The legacy flat-localhost fallback also
     * needs Secure because it uses SameSite=None.
     */
    secure: isProduction || needsCrossSiteCookie,

    sameSite: needsCrossSiteCookie ? "none" : "lax",

    path: "/",

    /*
     * Intentionally do not set `domain`.
     *
     * The refresh cookie belongs only to the API host:
     *
     * Development: api.shario.localhost
     * Production:  api.shario.io
     */
  };
};

export const getRefreshCookieOptions = (
  origin?: string | null,
  transportOptions: RefreshCookieTransportOptions = {},
): CookieOptions => ({
  ...getBaseRefreshCookieOptions(origin, transportOptions),

  maxAge: REFRESH_TOKEN_MAX_AGE_MS,
});

export const getClearRefreshCookieOptions = (
  origin?: string | null,
  transportOptions: RefreshCookieTransportOptions = {},
): CookieOptions => ({
  ...getBaseRefreshCookieOptions(origin, transportOptions),
});

/*
 * Previous shario.io builds could issue the refresh cookie with a parent Domain
 * attribute (for example `.shario.localhost` or `.shario.io`). A host-only cookie
 * and a parent-domain cookie with the same name may coexist, and clearing only
 * the current host-only cookie does not remove the legacy credential.
 *
 * New cookies intentionally remain API-host-only. These additional options are
 * used only while deleting cookies, and a candidate is accepted only when it
 * is the API host itself or one of its parent domains. Never derive a cookie
 * domain from the requesting tenant/custom-domain origin.
 */
const getLegacyRefreshCookieDomains = (): string[] => {
  const apiHostname = getOriginHostname(process.env.SERVER_URL);

  if (!apiHostname) {
    return [];
  }

  const configuredDomains = Object.keys(COOKIE_DOMAINS);

  const candidates = isProduction
    ? ["shario.io", ...configuredDomains]
    : [...getDevelopmentRootDomains(), ...configuredDomains];

  return [
    ...new Set(
      candidates
        .map(normalizeDevelopmentHostname)
        .filter(
          (domain) =>
            domain.includes(".") &&
            (apiHostname === domain || apiHostname.endsWith(`.${domain}`)),
        )
        .map((domain) => `.${domain}`),
    ),
  ];
};

export const getRefreshCookieCleanupOptions = (
  origin?: string | null,
  transportOptions: RefreshCookieTransportOptions = {},
): CookieOptions[] => {
  const baseOptions = getClearRefreshCookieOptions(origin, transportOptions);

  return [
    baseOptions,
    ...getLegacyRefreshCookieDomains().map((domain) => ({
      ...baseOptions,
      domain,
    })),
  ];
};

/*
|--------------------------------------------------------------------------
| Roles
|--------------------------------------------------------------------------
*/

export const getRoleFlags = (
  tenantRole?: TenantRole | null,
  platformRole?: PlatformRole | null,
): {
  isAdmin: boolean;
  isModerator: boolean;
} => {
  const tenantRoleValue = String(tenantRole ?? "")
    .trim()
    .toLowerCase();

  const platformRoleValue = String(platformRole ?? "")
    .trim()
    .toLowerCase();

  return {
    isAdmin:
      tenantRoleValue === "owner" ||
      tenantRoleValue === "admin" ||
      platformRoleValue === "super_admin" ||
      platformRoleValue === "admin" ||
      platformRoleValue === "owner",

    isModerator:
      tenantRoleValue === "moderator" ||
      tenantRoleValue === "admin" ||
      tenantRoleValue === "owner",
  };
};

/*
|--------------------------------------------------------------------------
| Access token
|--------------------------------------------------------------------------
*/

export const buildAccessToken = (
  user: AuthUserForToken,
  tenant?: AuthTenantForToken | null,
  workspaceAccess?: ResolvedWorkspaceAccess | null,
  authContext: AuthContext = AUTH_CONTEXT.WORKSPACE,
): string => {
  const userId = requireId(user._id ?? user.id, "User");

  const tenantId = requireId(
    tenant?._id ?? tenant?.id ?? user.tenant,
    "Tenant",
  );

  const isCustomerContext =
    authContext === AUTH_CONTEXT.CUSTOMER;
  const platformRole = isCustomerContext
    ? null
    : user.platformRole ?? null;

  /*
   * Customer-mode sessions deliberately carry no workspace membership,
   * permissions or role flags even when the same database user is an owner or
   * staff member. The signed authContext is the authorization boundary.
   */
  const legacyTenantRole = (() => {
    if (isCustomerContext) {
      return "customer";
    }

    if (workspaceAccess && workspaceAccess.status !== "active") {
      return "customer";
    }

    switch (workspaceAccess?.role) {
      case "owner":
        return "owner";
      case "admin":
        return "admin";
      case "manager":
      case "staff":
      case "accountant":
      case "viewer":
      case "custom":
        return "staff";
      default:
        return user.tenantRole;
    }
  })() as TenantRole;

  const roleFlags = isCustomerContext
    ? { isAdmin: false, isModerator: false }
    : getRoleFlags(legacyTenantRole, platformRole);

  const payload: AccessTokenPayload = {
    UserInfo: {
      id: userId,
      authContext,
      email: requireTokenEmail(user.email),
      name: user.firstname,
      firstname: user.firstname,
      lastname: user.lastname,
      customId: user.customId,
      memberNumber:
        Number.isSafeInteger(user.memberNumber) && Number(user.memberNumber) > 0
          ? Number(user.memberNumber)
          : null,
      tenant: tenantId,
      tenantRole: legacyTenantRole,
      platformRole,
      membershipId: isCustomerContext
        ? null
        : workspaceAccess?.membershipId ?? null,
      workspaceRole: isCustomerContext
        ? null
        : workspaceAccess?.role ?? null,
      authorizationVersion: isCustomerContext
        ? null
        : workspaceAccess?.accessVersion ?? null,
      sessionVersion: requireSessionVersion(user.sessionVersion),
      isAdmin: roleFlags.isAdmin,
      isModerator: roleFlags.isModerator,
    },
  };

  return jwt.sign(payload, requireEnv("ACCESS_TOKEN_SECRET"), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
};

/*
|--------------------------------------------------------------------------
| Refresh token
|--------------------------------------------------------------------------
*/

export const buildRefreshToken = (
  user: AuthUserForToken,
  tenant?: AuthTenantForToken | null,
  authContext: AuthContext = AUTH_CONTEXT.WORKSPACE,
): string => {
  const userId = requireId(user._id ?? user.id, "User");

  const tenantId = requireId(
    tenant?._id ?? tenant?.id ?? user.tenant,
    "Tenant",
  );

  const payload: RefreshTokenPayload = {
    id: userId,
    authContext,
    email: requireTokenEmail(user.email),
    tenant: tenantId,
    jti: crypto.randomUUID(),
    sessionVersion: requireSessionVersion(user.sessionVersion),
  };

  return jwt.sign(payload, requireEnv("REFRESH_TOKEN_SECRET"), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
};

export const getRefreshTokenAuthContext = (
  payload: RefreshTokenPayload,
): AuthContext =>
  payload.authContext ?? AUTH_CONTEXT.WORKSPACE;

export const verifyRefreshToken = (
  token: string,
): RefreshTokenPayload => {
  const decoded = jwt.verify(
    token,
    requireEnv(
      "REFRESH_TOKEN_SECRET",
    ),
    {
      algorithms: ["HS256"],
    },
  );

  if (
    typeof decoded === "string" ||
    !decoded.id ||
    !decoded.email ||
    !decoded.tenant ||
    !decoded.jti ||
    (
      decoded.authContext !== undefined &&
      decoded.authContext !== AUTH_CONTEXT.WORKSPACE &&
      decoded.authContext !== AUTH_CONTEXT.CUSTOMER
    ) ||
    (decoded.sessionVersion !== undefined &&
      (typeof decoded.sessionVersion !== "number" ||
        !Number.isSafeInteger(decoded.sessionVersion) ||
        decoded.sessionVersion < 0))
  ) {
    unauthorized("Invalid refresh token payload.");
  }

  return decoded as RefreshTokenPayload;
};


