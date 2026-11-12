import {
  AUTH_CONTEXT,
  AUTH_ERROR_MESSAGE,
  type AuthContext,
} from "@/modules/auth/auth.constants.js";
import { createAuthRepository } from "@/modules/auth/auth.repository.js";
import bcrypt from "bcryptjs";

import type {
  AuthTenantForToken,
  LoginInput,
} from "@/modules/auth/auth.types.js";
import {
  buildAccessToken,
  buildRefreshToken,
  getRefreshTokenAuthContext,
  normalizeEmail,
  verifyRefreshToken,
} from "@/modules/auth/auth.utils.js";
import {
  AppError,
  badRequest,
  forbidden,
  unauthorized,
} from "@/shared/http/httpErrors.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import {
  ensureLegacyWorkspaceMembershipForUser,
  resolveWorkspaceAccessForUser,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import { assertTenantAuthOrigin } from "@/modules/auth/auth-origin.js";
import { ensureUserMemberNumber } from "@/modules/user/user-member-number.assignment.service.js";

import {
  registerTenant,
  type RegisterTenantInput,
} from "./register.service.js";

const toId = (value: unknown): string => {
  return String(value ?? "").trim();
};

const decodeRefreshToken = (
  refreshToken: string,
): ReturnType<typeof verifyRefreshToken> => {
  try {
    return verifyRefreshToken(refreshToken);
  } catch {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }
};

const assertUserAccess = (user: { isAccessGranted?: boolean }): void => {
  if (!user.isAccessGranted) {
    forbidden(AUTH_ERROR_MESSAGE.ACCESS_DISABLED);
  }
};

const getMatchingLegacyCustomerToken = ({
  refreshToken,
  tenantId,
  userId,
}: {
  refreshToken?: string;
  tenantId: string;
  userId: string;
}): string | undefined => {
  if (!refreshToken) return undefined;

  try {
    const decoded = verifyRefreshToken(refreshToken);

    if (
      decoded.authContext === undefined &&
      toId(decoded.tenant) === tenantId &&
      toId(decoded.id) === userId
    ) {
      return refreshToken;
    }
  } catch {
    // A stale or unrelated cookie must not affect a successful password login.
  }

  return undefined;
};

const parseSessionVersion = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return 0;
  }

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const assertRefreshSessionVersion = ({
  tokenVersion,
  userVersion,
}: {
  tokenVersion: unknown;
  userVersion: unknown;
}): void => {
  const normalizedTokenVersion = parseSessionVersion(tokenVersion);
  const normalizedUserVersion = parseSessionVersion(userVersion);

  if (
    normalizedTokenVersion === null ||
    normalizedUserVersion === null ||
    normalizedTokenVersion !== normalizedUserVersion
  ) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }
};

/*
|--------------------------------------------------------------------------
| Login
|--------------------------------------------------------------------------
*/

const authenticatePasswordUser = async ({
  input,
  tenant,
}: {
  input: LoginInput;
  tenant: AuthTenantForToken;
}) => {
  const email = normalizeEmail(input.email);
  const tenantId = toId(tenant._id || tenant.id);

  if (!email || !input.password) {
    badRequest(AUTH_ERROR_MESSAGE.EMAIL_PASSWORD_REQUIRED);
  }

  if (!tenantId) {
    badRequest("Tenant context is required for login.");
  }

  const authRepository = createAuthRepository({ tenantId });
  const user = await authRepository.findByEmailWithSecrets(email);

  if (!user?.password) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_CREDENTIALS);
  }

  assertUserAccess(user);

  if (!(await bcrypt.compare(input.password, user.password))) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_CREDENTIALS);
  }

  const memberNumber = await ensureUserMemberNumber({
    tenantId,
    userId: user._id,
  });
  if (memberNumber !== null) user.memberNumber = memberNumber;

  return { tenantId, authRepository, user };
};

const assertCustomerModeAllowed = (user: {
  platformRole?: unknown;
}): void => {
  const platformRole = String(user.platformRole ?? "none").toLowerCase();

  if (platformRole !== "none") {
    forbidden({
      message: "Platform accounts cannot enter a customer portal session.",
      code: "CUSTOMER_CONTEXT_PLATFORM_ACCOUNT_FORBIDDEN",
    });
  }
};

const requireActiveWorkspaceAccess = (
  workspaceAccess: ResolvedWorkspaceAccess | null,
): ResolvedWorkspaceAccess => {
  if (!workspaceAccess || workspaceAccess.status !== "active") {
    forbidden({
      message: "This account does not have active workspace access.",
      code: "WORKSPACE_ACCOUNT_REQUIRED",
    });
  }

  return workspaceAccess;
};

/**
 * Backwards-compatible tenant login. Workspace identities receive a workspace
 * session. A pure customer identity receives a customer session and cookie so
 * central sign-in can route both account types without mixing credentials.
 */
export const loginUser = async ({
  input,
  tenant,
  oldRefreshToken,
  oldCustomerRefreshToken,
}: {
  input: LoginInput;
  tenant: AuthTenantForToken;
  oldRefreshToken?: string;
  oldCustomerRefreshToken?: string;
}) => {
  const { tenantId, authRepository, user } =
    await authenticatePasswordUser({ input, tenant });
  const resolvedWorkspaceAccess =
    await ensureLegacyWorkspaceMembershipForUser({ tenantId, user });
  const isActiveWorkspace =
    resolvedWorkspaceAccess?.status === "active";
  const isPureCustomer =
    !resolvedWorkspaceAccess &&
    String(user.tenantRole) === "customer" &&
    String(user.platformRole ?? "none") === "none";

  if (!isActiveWorkspace && !isPureCustomer) {
    requireActiveWorkspaceAccess(resolvedWorkspaceAccess);
  }

  const authContext = isPureCustomer
    ? AUTH_CONTEXT.CUSTOMER
    : AUTH_CONTEXT.WORKSPACE;
  const workspaceAccess = isPureCustomer
    ? null
    : requireActiveWorkspaceAccess(resolvedWorkspaceAccess);
  const accessToken = buildAccessToken(
    user,
    tenant,
    workspaceAccess,
    authContext,
  );
  const refreshToken = buildRefreshToken(
    user,
    tenant,
    authContext,
  );
  const matchingLegacyCustomerToken = isPureCustomer && !oldCustomerRefreshToken
    ? getMatchingLegacyCustomerToken({
        refreshToken: oldRefreshToken,
        tenantId,
        userId: toId(user._id || user.id),
      })
    : undefined;
  const previousToken = isPureCustomer
    ? oldCustomerRefreshToken ?? matchingLegacyCustomerToken
    : oldRefreshToken;

  await authRepository.rotateRefreshToken({
    userId: user._id,
    oldRefreshToken: previousToken,
    newRefreshToken: refreshToken,
  });

  return {
    accessToken,
    refreshToken,
    user,
    tenant,
    workspaceAccess,
    authContext,
    migratedLegacyCustomerSession: Boolean(matchingLegacyCustomerToken),
  };
};

/**
 * Explicit customer-mode password login. The same tenant account credentials
 * may be used, but the issued token deliberately contains no workspace role,
 * membership or platform privileges.
 */
export const loginCustomerUser = async ({
  input,
  tenant,
  oldRefreshToken,
}: {
  input: LoginInput;
  tenant: AuthTenantForToken;
  oldRefreshToken?: string;
}) => {
  const { authRepository, user } =
    await authenticatePasswordUser({ input, tenant });

  assertCustomerModeAllowed(user);

  const accessToken = buildAccessToken(
    user,
    tenant,
    null,
    AUTH_CONTEXT.CUSTOMER,
  );
  const refreshToken = buildRefreshToken(
    user,
    tenant,
    AUTH_CONTEXT.CUSTOMER,
  );

  await authRepository.rotateRefreshToken({
    userId: user._id,
    oldRefreshToken,
    newRefreshToken: refreshToken,
  });

  return {
    accessToken,
    refreshToken,
    user,
    tenant,
    workspaceAccess: null,
    authContext: AUTH_CONTEXT.CUSTOMER,
  };
};

/*
|--------------------------------------------------------------------------
| Logout
|--------------------------------------------------------------------------
*/

export const logoutUser = async (
  refreshToken?: string,
  expectedContext: AuthContext = AUTH_CONTEXT.WORKSPACE,
): Promise<void> => {
  if (!refreshToken) {
    return;
  }

  let decoded: ReturnType<typeof verifyRefreshToken>;

  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    // Invalid and expired credentials are already unusable. Logout remains
    // idempotent for them, but storage failures below must remain observable.
    return;
  }

  // Cookie names are a browser transport detail; the signed context is the
  // session boundary. A token placed in the wrong cookie must never revoke
  // the other authentication context.
  if (getRefreshTokenAuthContext(decoded) !== expectedContext) {
    return;
  }

  const tenantId = toId(decoded.tenant);

  if (!tenantId) {
    return;
  }

  const authRepository = createAuthRepository({
    tenantId,
  });

  await authRepository.removeRefreshTokenFromUser(refreshToken);
};

/*
|--------------------------------------------------------------------------
| Refresh access token
|--------------------------------------------------------------------------
*/

const refreshAccessTokenForContext = async ({
  refreshToken,
  requestOrigin,
  expectedContext,
  allowLegacyCustomer = false,
}: {
  refreshToken?: string;
  requestOrigin?: string;
  expectedContext: AuthContext;
  allowLegacyCustomer?: boolean;
}) => {
  if (!refreshToken) {
    unauthorized(AUTH_ERROR_MESSAGE.REFRESH_TOKEN_REQUIRED);
  }

  const decoded = decodeRefreshToken(refreshToken);
  const explicitContext = decoded.authContext;
  const tokenContext = getRefreshTokenAuthContext(decoded);
  const isLegacyCustomerCandidate =
    expectedContext === AUTH_CONTEXT.CUSTOMER &&
    explicitContext === undefined &&
    allowLegacyCustomer;
  const isWorkspaceCookieCustomerProbe =
    expectedContext === AUTH_CONTEXT.CUSTOMER &&
    explicitContext === AUTH_CONTEXT.WORKSPACE &&
    allowLegacyCustomer;

  if (
    !isLegacyCustomerCandidate &&
    !isWorkspaceCookieCustomerProbe &&
    tokenContext !== expectedContext
  ) {
    unauthorized({
      message: "The refresh token belongs to a different authentication context.",
      code: "AUTH_CONTEXT_MISMATCH",
    });
  }

  const tenantId = toId(decoded.tenant);
  const decodedUserId = toId(decoded.id);

  if (!tenantId || !decodedUserId) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }

  const tenant = await getTenantOrThrow(tenantId);
  assertTenantAuthOrigin({ origin: requestOrigin, tenant });

  const authRepository = createAuthRepository({ tenantId });
  const user = await authRepository.findByRefreshTokenWithSecrets(refreshToken);

  if (!user) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }

  const userId = toId(user._id || user.id);

  if (!userId || userId !== decodedUserId) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }

  assertRefreshSessionVersion({
    tokenVersion: decoded.sessionVersion,
    userVersion: user.sessionVersion,
  });

  assertUserAccess(user);

  if (isWorkspaceCookieCustomerProbe) {
    // A customer-session lookup may encounter the staff cookie while checking
    // for old customer sessions. Validate it first so invalid, expired, revoked
    // or cross-tenant credentials still reach the normal authentication logs.
    // Never issue/rotate tokens or write user data for this expected rejection.
    throw new AppError({
      statusCode: 401,
      message: "The refresh token belongs to a different authentication context.",
      code: "AUTH_CONTEXT_MISMATCH",
      logReason: "workspace_cookie_customer_probe",
    });
  }

  const currentMemberNumber = await ensureUserMemberNumber({
    tenantId,
    userId,
  });
  if (currentMemberNumber !== null) user.memberNumber = currentMemberNumber;

  let workspaceAccess: ResolvedWorkspaceAccess | null = null;

  if (expectedContext === AUTH_CONTEXT.WORKSPACE) {
    workspaceAccess = requireActiveWorkspaceAccess(
      await ensureLegacyWorkspaceMembershipForUser({ tenantId, user }),
    );
  } else {
    assertCustomerModeAllowed(user);

    if (isLegacyCustomerCandidate) {
      const legacyWorkspaceAccess = await resolveWorkspaceAccessForUser({
        tenantId,
        userId,
      });
      const isLegacyCustomer =
        String(user.tenantRole) === "customer" &&
        !legacyWorkspaceAccess;

      if (!isLegacyCustomer) {
        unauthorized({
          message: "The legacy refresh token is not a customer session.",
          code: "AUTH_CONTEXT_MISMATCH",
        });
      }
    }
  }

  const accessToken = buildAccessToken(
    user,
    tenant,
    workspaceAccess,
    expectedContext,
  );
  const newRefreshToken = buildRefreshToken(
    user,
    tenant,
    expectedContext,
  );
  const rotated = await authRepository.compareAndSwapRefreshToken({
    userId: user._id,
    oldRefreshToken: refreshToken,
    newRefreshToken,
  });

  if (!rotated) {
    unauthorized(AUTH_ERROR_MESSAGE.INVALID_REFRESH_TOKEN);
  }

  return {
    accessToken,
    refreshToken: newRefreshToken,
    user,
    tenant,
    workspaceAccess,
    authContext: expectedContext,
    migratedLegacyCustomerSession: isLegacyCustomerCandidate,
  };
};

export const refreshAccessToken = async (
  refreshToken?: string,
  requestOrigin?: string,
) => refreshAccessTokenForContext({
  refreshToken,
  requestOrigin,
  expectedContext: AUTH_CONTEXT.WORKSPACE,
});

export const refreshCustomerAccessToken = async (
  refreshToken?: string,
  requestOrigin?: string,
  options: { allowLegacyCustomer?: boolean } = {},
) => refreshAccessTokenForContext({
  refreshToken,
  requestOrigin,
  expectedContext: AUTH_CONTEXT.CUSTOMER,
  allowLegacyCustomer: options.allowLegacyCustomer === true,
});

/**
 * Logout remains idempotent for missing/invalid credentials, but a valid
 * refresh credential may only be acted on by its own tenant origin.
 */
export const assertRefreshTokenOrigin = async (
  refreshToken?: string,
  requestOrigin?: string,
): Promise<void> => {
  if (!refreshToken || !requestOrigin) {
    return;
  }

  let decoded: ReturnType<typeof verifyRefreshToken>;

  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    return;
  }

  const tenantId = toId(decoded.tenant);

  if (!tenantId || !/^[a-f\d]{24}$/i.test(tenantId)) {
    return;
  }

  const tenant = await findTenantById(tenantId);

  // A correctly signed credential can outlive deletion of its tenant. It is
  // unusable and does not need an origin decision; the controller will still
  // expire the browser cookie.
  if (!tenant) {
    return;
  }

  assertTenantAuthOrigin({
    origin: requestOrigin,
    tenant,
  });
};

/*
|--------------------------------------------------------------------------
| Persist refresh token
|--------------------------------------------------------------------------
*/

export const persistRefreshToken = async ({
  tenantId,
  userId,
  refreshToken,
}: {
  tenantId: string;
  userId: string;
  refreshToken: string;
}): Promise<void> => {
  const normalizedTenantId = toId(tenantId);
  const normalizedUserId = toId(userId);

  if (!normalizedTenantId || !normalizedUserId || !refreshToken) {
    throw new Error("Tenant ID, user ID and refresh token are required.");
  }

  const authRepository = createAuthRepository({
    tenantId: normalizedTenantId,
  });

  await authRepository.addRefreshTokenToUser({
    userId: normalizedUserId,
    refreshToken,
  });
};

/*
|--------------------------------------------------------------------------
| Register new tenant
|--------------------------------------------------------------------------
*/

type RegisterTenantServiceResult = Awaited<ReturnType<typeof registerTenant>>;

export type RegisterNewTenantResult = {
  accessToken: string;
  refreshToken: string;
  authContext: AuthContext;
  user: RegisterTenantServiceResult["owner"];
  tenant: RegisterTenantServiceResult["tenant"];
  workspaceAccess: ResolvedWorkspaceAccess;
};

export const registerNewTenant = async ({
  input,
}: {
  input: RegisterTenantInput;
}): Promise<RegisterNewTenantResult> => {
  const normalizedInput: RegisterTenantInput = {
    firstname: input.firstname.trim(),
    lastname: input.lastname.trim(),
    email: normalizeEmail(input.email),
    password: input.password,
    tenantName: input.tenantName.trim(),
    slug: input.slug.trim().toLowerCase(),
    locale: input.locale,
    country: input.country,
    currency: input.currency,
    timezone: input.timezone,
  };

  if (
    !normalizedInput.firstname ||
    !normalizedInput.lastname ||
    !normalizedInput.email ||
    !normalizedInput.password ||
    !normalizedInput.tenantName ||
    !normalizedInput.slug
  ) {
    badRequest("All required registration fields must be provided.");
  }

  /*
   * registerTenant() creates the tenant and its owner inside one MongoDB
   * transaction. The password is hashed inside that service.
   */
  const { tenant, owner, workspaceAccess } = await registerTenant({
    input: normalizedInput,
  });

  const tenantId = toId(tenant._id || tenant.id);
  const ownerId = toId(owner._id || owner.id);

  if (!tenantId || !ownerId) {
    throw new Error("Tenant registration completed without valid identifiers.");
  }

  const accessToken = buildAccessToken(
    owner,
    tenant,
    workspaceAccess,
    AUTH_CONTEXT.WORKSPACE,
  );
  const refreshToken = buildRefreshToken(
    owner,
    tenant,
    AUTH_CONTEXT.WORKSPACE,
  );

  await persistRefreshToken({
    tenantId,
    userId: ownerId,
    refreshToken,
  });

  return {
    accessToken,
    refreshToken,
    authContext: AUTH_CONTEXT.WORKSPACE,
    user: owner,
    tenant,
    workspaceAccess,
  };
};


