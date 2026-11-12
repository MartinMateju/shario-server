import type { NextFunction, Response } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

import {
  AUTH_CONTEXT,
  type AuthContext,
} from "@/modules/auth/auth.constants.js";
import type {
  AccessTokenPayload,
  AuthenticatedRequest,
} from "@/modules/auth/auth.types.js";
import UserModel from "@/modules/user/user.model.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

type VerifiedUserInfo = NonNullable<AccessTokenPayload["UserInfo"]> & {
  id: string;
  email: string;
  tenant: string;
};

type VerifiedAccessTokenPayload = AccessTokenPayload & {
  UserInfo: VerifiedUserInfo;
};

const getAccessTokenSecret = (): string => {
  const secret = process.env.ACCESS_TOKEN_SECRET;

  if (!secret) {
    throw new Error("ACCESS_TOKEN_SECRET environment variable is not defined.");
  }

  return secret;
};

const extractBearerToken = (authorization: string | undefined): string => {
  if (!authorization) {
    return "";
  }

  const parts = authorization.trim().split(/\s+/);

  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return "";
  }

  return parts[1]?.trim() ?? "";
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const parseSessionVersion = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return 0;
  }

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const isAccessTokenPayload = (
  decoded: string | JwtPayload,
): decoded is VerifiedAccessTokenPayload => {
  if (typeof decoded === "string" || !decoded || typeof decoded !== "object") {
    return false;
  }

  const payload = decoded as Partial<AccessTokenPayload>;
  const userInfo = payload.UserInfo;

  return Boolean(
    userInfo &&
      isNonEmptyString(userInfo.id) &&
      isNonEmptyString(userInfo.email) &&
      isNonEmptyString(userInfo.tenant) &&
      parseSessionVersion(userInfo.sessionVersion) !== null &&
      (userInfo.authContext === undefined ||
        userInfo.authContext === AUTH_CONTEXT.WORKSPACE ||
        userInfo.authContext === AUTH_CONTEXT.CUSTOMER),
  );
};

const isMissingLegacyAuthorizationClaim = (value: unknown): boolean =>
  value === undefined || value === null;

const isPureLegacyCustomerToken = (userInfo: VerifiedUserInfo): boolean => {
  const claims = userInfo as unknown as Record<string, unknown>;

  return (
    claims.tenantRole === "customer" &&
    (isMissingLegacyAuthorizationClaim(claims.platformRole) ||
      claims.platformRole === "none") &&
    isMissingLegacyAuthorizationClaim(claims.membershipId) &&
    isMissingLegacyAuthorizationClaim(claims.workspaceRole) &&
    isMissingLegacyAuthorizationClaim(claims.authorizationVersion) &&
    claims.isAdmin === false &&
    claims.isModerator === false
  );
};

const resolveAccessTokenAuthContext = (
  userInfo: VerifiedUserInfo,
): AuthContext => {
  if (userInfo.authContext !== undefined) {
    return userInfo.authContext;
  }

  return isPureLegacyCustomerToken(userInfo)
    ? AUTH_CONTEXT.CUSTOMER
    : AUTH_CONTEXT.WORKSPACE;
};

export const verifyJWT = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    unauthorized("Missing access token.");
  }

  // Read the configuration outside the verification
  // try/catch. Missing server configuration must produce
  // a server error, not an invalid-token response.
  const secret = getAccessTokenSecret();

  let decoded: string | JwtPayload;

  try {
    decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      unauthorized("Access token has expired.");
    }

    if (error instanceof jwt.NotBeforeError) {
      unauthorized("Access token is not active yet.");
    }

    if (error instanceof jwt.JsonWebTokenError) {
      unauthorized("Invalid access token.");
    }

    throw error;
  }

  if (!isAccessTokenPayload(decoded)) {
    unauthorized("Invalid access token payload.");

    // `unauthorized` throws at runtime. The explicit return also lets
    // TypeScript narrow decoded to VerifiedAccessTokenPayload below.
    return;
  }

  const tokenSessionVersion = parseSessionVersion(
    decoded.UserInfo.sessionVersion,
  );

  const user = await UserModel.findOne({
    _id: decoded.UserInfo.id,
    tenant: decoded.UserInfo.tenant,
  })
    .select("+sessionVersion isAccessGranted")
    .lean()
    .exec();

  const persistedSessionVersion = parseSessionVersion(user?.sessionVersion);

  if (
    !user ||
    user.isAccessGranted === false ||
    tokenSessionVersion === null ||
    persistedSessionVersion === null ||
    tokenSessionVersion !== persistedSessionVersion
  ) {
    unauthorized("Access session is no longer valid.");
  }

  req.userInfo = {
    ...decoded.UserInfo,
    authContext: resolveAccessTokenAuthContext(decoded.UserInfo),
  };

  next();
};

export default verifyJWT;

