import crypto from "node:crypto";

import {
  AUTH_CONTEXT,
  type AuthContext,
} from "@/modules/auth/auth.constants.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

const HANDOFF_VERSION = "v1";
const HANDOFF_AAD = Buffer.from("shario-auth-session-handoff-v1", "utf8");
const HANDOFF_TTL_MS = 2 * 60 * 1_000;
const MAX_HANDOFF_LENGTH = 4_096;
const MINIMUM_HANDOFF_SECRET_BYTES = 32;

type SessionHandoffPayload = {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  origin: string;
  authContext: AuthContext;
  refreshToken: string;
};

export type ConsumedSessionHandoff = Pick<
  SessionHandoffPayload,
  "origin" | "authContext" | "refreshToken"
>;

const invalidHandoff = (): never =>
  unauthorized({
    message: "The session handoff is invalid or has expired.",
    code: "AUTH_SESSION_HANDOFF_INVALID",
  });

const getConfiguredSecret = (): string =>
  String(process.env.AUTH_SESSION_HANDOFF_SECRET ?? "").trim();

export const isSessionHandoffConfigured = (): boolean =>
  Buffer.byteLength(getConfiguredSecret(), "utf8") >=
  MINIMUM_HANDOFF_SECRET_BYTES;

const getEncryptionKey = (): Buffer => {
  const secret = getConfiguredSecret();

  if (Buffer.byteLength(secret, "utf8") < MINIMUM_HANDOFF_SECRET_BYTES) {
    throw new Error(
      "AUTH_SESSION_HANDOFF_SECRET must contain at least 32 bytes.",
    );
  }

  return crypto
    .createHash("sha256")
    .update("shario-auth-session-handoff-key\0", "utf8")
    .update(secret, "utf8")
    .digest();
};

const normalizeOrigin = (value: unknown): string => {
  const raw = String(value ?? "").trim();

  try {
    const parsed = new URL(raw);

    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (process.env.NODE_ENV === "production" &&
        (parsed.protocol !== "https:" || parsed.port !== ""))
    ) {
      return "";
    }

    return parsed.origin;
  } catch {
    return "";
  }
};

const isAuthContext = (value: unknown): value is AuthContext =>
  value === AUTH_CONTEXT.WORKSPACE || value === AUTH_CONTEXT.CUSTOMER;

/**
 * Seals, but does not expose, a refresh token for a short custom-domain
 * handoff. The opaque value is single-use in practice because consuming it
 * immediately rotates the embedded refresh credential with compare-and-swap.
 */
export const createSessionHandoff = ({
  refreshToken,
  authContext,
  origin,
  now = Date.now(),
}: {
  refreshToken: string;
  authContext: AuthContext;
  origin: string;
  now?: number;
}): string => {
  const normalizedOrigin = normalizeOrigin(origin);

  if (!refreshToken || !isAuthContext(authContext) || !normalizedOrigin) {
    throw new Error("A refresh token, context and valid origin are required.");
  }

  const payload: SessionHandoffPayload = {
    version: 1,
    issuedAt: now,
    expiresAt: now + HANDOFF_TTL_MS,
    nonce: crypto.randomBytes(16).toString("base64url"),
    origin: normalizedOrigin,
    authContext,
    refreshToken,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);

  cipher.setAAD(HANDOFF_AAD);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authenticationTag = cipher.getAuthTag();

  return [
    HANDOFF_VERSION,
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    authenticationTag.toString("base64url"),
  ].join(".");
};

export const consumeSessionHandoff = (
  handoff: string,
  now = Date.now(),
): ConsumedSessionHandoff => {
  if (
    typeof handoff !== "string" ||
    handoff.length === 0 ||
    handoff.length > MAX_HANDOFF_LENGTH
  ) {
    invalidHandoff();
  }

  const [version, encodedIv, encodedPayload, encodedTag, extra] =
    handoff.split(".");

  if (
    version !== HANDOFF_VERSION ||
    !encodedIv ||
    !encodedPayload ||
    !encodedTag ||
    extra !== undefined
  ) {
    invalidHandoff();
  }

  let decoded: unknown;

  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const encrypted = Buffer.from(encodedPayload, "base64url");
    const authenticationTag = Buffer.from(encodedTag, "base64url");

    if (iv.length !== 12 || authenticationTag.length !== 16) {
      invalidHandoff();
    }

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      iv,
    );

    decipher.setAAD(HANDOFF_AAD);
    decipher.setAuthTag(authenticationTag);

    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");

    decoded = JSON.parse(plaintext);
  } catch {
    invalidHandoff();
  }

  if (!decoded || typeof decoded !== "object") {
    invalidHandoff();
  }

  const payload = decoded as Partial<SessionHandoffPayload>;
  const normalizedOrigin = normalizeOrigin(payload.origin);

  if (
    payload.version !== 1 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    Number(payload.issuedAt) > now + 5_000 ||
    Number(payload.expiresAt) <= now ||
    Number(payload.expiresAt) - Number(payload.issuedAt) !== HANDOFF_TTL_MS ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z\d_-]{20,30}$/.test(payload.nonce) ||
    !normalizedOrigin ||
    normalizedOrigin !== payload.origin ||
    !isAuthContext(payload.authContext) ||
    typeof payload.refreshToken !== "string" ||
    payload.refreshToken.length < 32 ||
    payload.refreshToken.length > 4_096
  ) {
    invalidHandoff();
  }

  return {
    origin: normalizedOrigin,
    authContext: payload.authContext,
    refreshToken: payload.refreshToken,
  };
};
