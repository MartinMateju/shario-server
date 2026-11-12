import crypto from "node:crypto";
import type { Request } from "express";

import { AppError, forbidden } from "@/shared/http/httpErrors.js";

export const AUTH_PROXY_HEADERS = {
  ORIGIN: "x-shario-auth-proxy-origin",
  TIMESTAMP: "x-shario-auth-proxy-timestamp",
  NONCE: "x-shario-auth-proxy-nonce",
  SIGNATURE: "x-shario-auth-proxy-signature",
} as const;

const AUTH_PROXY_SIGNATURE_VERSION = "shario-auth-proxy-v1";
const AUTH_PROXY_MAX_CLOCK_SKEW_MS = 60_000;
const MINIMUM_PROXY_SECRET_BYTES = 32;

export type AuthRequestContext = {
  origin?: string;
  firstPartyProxy: boolean;
};

type SignatureInput = {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  origin: string;
  cookieHeader?: string;
  body?: unknown;
};

const invalidProxyRequest = (): never =>
  forbidden({
    message: "The first-party authentication proxy request is invalid.",
    code: "AUTH_FIRST_PARTY_PROXY_INVALID",
  });

const normalizeProxyOrigin = (value: unknown): string => {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return "";
  }

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

const normalizeProxyTarget = (value: unknown): string => {
  const target = String(value ?? "");

  return target.startsWith("/") && !/[\r\n#]/.test(target) ? target : "";
};

const normalizeProxyNonce = (value: unknown): string => {
  const nonce = String(value ?? "").trim();

  // A BFF should generate at least 128 random bits and encode them as
  // base64url. Keeping the accepted alphabet narrow also makes the canonical
  // request unambiguous and safe to use when deriving the Redis claim key.
  return /^[A-Za-z\d_-]{22,128}$/.test(nonce) ? nonce : "";
};

const canonicalizeBodyValue = (value: unknown): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeBodyValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeBodyValue(entry)]),
    );
  }

  return null;
};

export const canonicalizeAuthProxyBody = (body: unknown): string =>
  body === undefined ? "" : JSON.stringify(canonicalizeBodyValue(body));

const hashCookieHeader = (cookieHeader?: string): string =>
  crypto
    .createHash("sha256")
    .update(String(cookieHeader ?? ""), "utf8")
    .digest("hex");

const hashRequestBody = (body: unknown): string =>
  crypto
    .createHash("sha256")
    .update(canonicalizeAuthProxyBody(body), "utf8")
    .digest("hex");

const buildCanonicalProxyRequest = ({
  timestamp,
  nonce,
  method,
  path,
  origin,
  cookieHeader,
  body,
}: Omit<SignatureInput, "secret">): string =>
  [
    AUTH_PROXY_SIGNATURE_VERSION,
    timestamp,
    normalizeProxyNonce(nonce),
    method.trim().toUpperCase(),
    normalizeProxyTarget(path),
    normalizeProxyOrigin(origin),
    hashCookieHeader(cookieHeader),
    hashRequestBody(body),
  ].join("\n");

/**
 * Shared by tests and documented BFF implementations. The secret belongs only
 * to the API and the server-side frontend proxy; it must never be included in
 * a NEXT_PUBLIC_* variable or sent to a browser.
 */
export const createAuthProxySignature = (input: SignatureInput): string =>
  crypto
    .createHmac("sha256", input.secret)
    .update(buildCanonicalProxyRequest(input), "utf8")
    .digest("hex");

const getProxySecret = (): string => {
  const secret = String(process.env.AUTH_FIRST_PARTY_PROXY_SECRET ?? "").trim();

  if (Buffer.byteLength(secret, "utf8") < MINIMUM_PROXY_SECRET_BYTES) {
    invalidProxyRequest();
  }

  return secret;
};

const signaturesMatch = (received: string, expected: string): boolean => {
  if (!/^[a-f\d]{64}$/i.test(received)) {
    return false;
  }

  const receivedBytes = Buffer.from(received, "hex");
  const expectedBytes = Buffer.from(expected, "hex");

  return (
    receivedBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(receivedBytes, expectedBytes)
  );
};

export type ClaimAuthProxyNonce = (
  nonce: string,
  ttlMs: number,
) => Promise<boolean>;

/**
 * Claims a signed proxy nonce across every API instance. Redis' atomic NX
 * write closes the replay window for login requests, which do not have an old
 * refresh token whose compare-and-swap could otherwise reject a duplicate.
 */
export const claimAuthProxyNonce: ClaimAuthProxyNonce = async (
  nonce,
  ttlMs,
) => {
  /*
   * Keep ordinary/direct authentication imports independent from Redis. The
   * production proxy path loads the shared connection only after a request's
   * signature has passed all local validation and fails closed if Redis is
   * unavailable.
   */
  const { redisConnection } = await import("@/infrastructure/redis/redis.js");
  const digest = crypto
    .createHash("sha256")
    .update(nonce, "utf8")
    .digest("hex");
  const result = await redisConnection.set(
    `shario:auth-proxy:nonce:${digest}`,
    "1",
    "PX",
    ttlMs,
    "NX",
  );

  return result === "OK";
};

/**
 * Resolves the browser origin for an authentication request.
 *
 * Paid custom domains must call auth through a same-origin server-side proxy
 * so the browser stores and sends the HttpOnly refresh cookie as first-party.
 * The signed headers keep the existing origin/tenant binding intact even
 * though the API receives the second hop from the frontend server.
 */
export const resolveAuthRequestContext = async (
  req: Request,
  now = Date.now(),
  claimNonce: ClaimAuthProxyNonce = claimAuthProxyNonce,
): Promise<AuthRequestContext> => {
  const forwardedOrigin = req.get(AUTH_PROXY_HEADERS.ORIGIN);
  const timestamp = req.get(AUTH_PROXY_HEADERS.TIMESTAMP);
  const nonce = req.get(AUTH_PROXY_HEADERS.NONCE);
  const signature = req.get(AUTH_PROXY_HEADERS.SIGNATURE);
  const proxyHeaderCount = [
    forwardedOrigin,
    timestamp,
    nonce,
    signature,
  ].filter((value) => Boolean(String(value ?? "").trim())).length;

  if (proxyHeaderCount === 0) {
    const origin = normalizeProxyOrigin(req.get("origin"));

    return {
      origin: origin || undefined,
      firstPartyProxy: false,
    };
  }

  if (proxyHeaderCount !== 4) {
    invalidProxyRequest();
  }

  const origin = normalizeProxyOrigin(forwardedOrigin);
  const path = normalizeProxyTarget(req.originalUrl || req.url);
  const normalizedNonce = normalizeProxyNonce(nonce);
  const parsedTimestamp = Number(timestamp);

  if (
    !origin ||
    !path ||
    !normalizedNonce ||
    !/^\d{13}$/.test(String(timestamp)) ||
    !Number.isSafeInteger(parsedTimestamp) ||
    Math.abs(now - parsedTimestamp) > AUTH_PROXY_MAX_CLOCK_SKEW_MS
  ) {
    invalidProxyRequest();
  }

  const ordinaryOrigin = normalizeProxyOrigin(req.get("origin"));

  if (ordinaryOrigin && ordinaryOrigin !== origin) {
    invalidProxyRequest();
  }

  const expected = createAuthProxySignature({
    secret: getProxySecret(),
    timestamp: String(timestamp),
    nonce: normalizedNonce,
    method: req.method,
    path,
    origin,
    cookieHeader: req.get("cookie"),
    body: req.body,
  });

  if (!signaturesMatch(String(signature), expected)) {
    invalidProxyRequest();
  }

  const replayClaimTtlMs = Math.max(
    1_000,
    parsedTimestamp + AUTH_PROXY_MAX_CLOCK_SKEW_MS - now + 1_000,
  );

  let claimed: boolean;

  try {
    claimed = await claimNonce(normalizedNonce, replayClaimTtlMs);
  } catch {
    throw new AppError({
      statusCode: 503,
      message:
        "The first-party authentication proxy is temporarily unavailable.",
      code: "AUTH_FIRST_PARTY_PROXY_UNAVAILABLE",
    });
  }

  if (!claimed) {
    invalidProxyRequest();
  }

  return {
    origin,
    firstPartyProxy: true,
  };
};
