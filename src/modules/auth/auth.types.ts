import type { Request } from "express";
import type { JwtPayload } from "jsonwebtoken";
import type { Types } from "mongoose";

import type {
  PlatformRole,
  TenantRole,
} from "@/modules/user/user.constants.js";
import type { AuthContext } from "@/modules/auth/auth.constants.js";

export type AuthRoleFlag = {
  isAdmin: boolean;
  isModerator: boolean;
};

export type AuthTenantRole = TenantRole;
export type AuthPlatformRole = PlatformRole;

export type AuthUserForToken = {
  _id: Types.ObjectId | string;
  id?: string;

  /**
   * Imported legacy users may not have an email. Token issuance validates this
   * at runtime and fails closed instead of signing an unusable session.
   */
  email?: string;
  firstname: string;
  lastname: string;
  customId: string;
  memberNumber?: number | null;

  tenant: Types.ObjectId | string;
  tenantRole: AuthTenantRole;
  platformRole?: AuthPlatformRole | null;
  sessionVersion?: number | null;
};

export type AuthTenantForToken = {
  _id: Types.ObjectId | string;
  id?: string;

  name?: string;
  slug?: string;
  plan?: string;
  planVersion?: number;

  modules?: Record<string, boolean>;
  limits?: Record<string, number>;
  settings?: Record<string, unknown>;
  publicSite?: unknown;
  workspaceIntent?: { pricingMode?: string | null } | null;
};

export type AccessTokenUserInfo = {
  id: string;
  /** Missing only on pre-auth-context workspace tokens during rollout. */
  authContext?: AuthContext;

  email: string;
  name: string;
  firstname: string;
  lastname: string;
  customId: string;
  memberNumber?: number | null;

  tenant: string;
  tenantRole: AuthTenantRole;
  platformRole: AuthPlatformRole | null;

  /**
   * Workspace authorization is resolved from TenantMembership on every
   * protected request. These claims are only session hints and must never be
   * treated as the source of truth for permission checks.
   */
  membershipId?: string | null;
  workspaceRole?: string | null;
  authorizationVersion?: number | null;

  /**
   * Server-side session generation. Versionless tokens from older releases
   * are treated as version 0 during the rolling migration.
   */
  sessionVersion?: number;

  isAdmin: boolean;
  isModerator: boolean;
};

export type AccessTokenPayload = JwtPayload & {
  UserInfo: AccessTokenUserInfo;
};

export type RefreshTokenPayload = JwtPayload & {
  id: string;
  /** Missing only on legacy tokens; those default to workspace context. */
  authContext?: AuthContext;
  email: string;
  tenant: string;
  /**
   * Every refresh token is a distinct session credential. The jti is not
   * trusted on its own, but makes accidental token duplication observable and
   * lets rotation use a true one-token-for-one-token compare-and-swap.
   */
  jti: string;
  /**
   * Optional only for compatibility with refresh tokens issued before the
   * server-side session generation was introduced.
   */
  sessionVersion?: number;
};

export type AuthenticatedRequest = Request & {
  /**
   * Set by verifyJWT after validating the access token.
   */
  userInfo?: AccessTokenUserInfo;

  /**
   * Optional resolved tenant context, used by endpoints that resolve
   * a tenant through its domain or hostname.
   */
  tenant?: AuthTenantForToken | null;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type RegisterInput = {
  firstname: string;
  lastname: string;
  email: string;
  password: string;
  phone?: string;
};

export type PasswordResetRequestInput = {
  email: string;
};

export type PasswordResetInput = {
  email: string;
  otp: string;
  password: string;
};

export type VerifyOtpInput = {
  email: string;
  otp: string;
};
