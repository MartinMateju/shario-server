import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/shared/http/AppError.js";
import { buildTenantCommerceUrl, normalizeCommerceLocale } from "./checkout.urls.js";

const PURPOSE = "shario:guest-course-checkout:v1";
export const GUEST_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const digest = (context: string, encoding: "hex" | "base64url" = "hex") => {
  const secret = process.env.ACCESS_TOKEN_SECRET || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new AppError({
      statusCode: 503,
      code: "GUEST_CHECKOUT_CONFIGURATION_REQUIRED",
      message: "Guest checkout is temporarily unavailable.",
    });
  }
  return createHmac("sha256", secret).update(`${PURPOSE}:${context}`).digest(encoding);
};

/** A retry maps to the same non-login principal; an email never identifies it. */
export const deriveGuestCheckoutUserId = (tenantId: string, key: string) => {
  // Validate proof configuration before allocating any persistent records.
  digest("configuration-check");
  // A signing-secret rotation must not turn the same payment key into a new
  // operation namespace. The UUIDv4 provides 122 bits of random input.
  return createHash("sha256")
    .update(`${PURPOSE}:identity:${tenantId.toLowerCase()}:${key}`).digest("hex").slice(0, 24);
};

export const hashGuestAccessToken = (token: string) =>
  createHash("sha256").update(`${PURPOSE}:proof:${token}`).digest("hex");

export type GuestCourseCheckoutSnapshot = {
  version: 1;
  accessNonce: string;
  accessTokenHash: string;
  accessExpiresAt: Date;
  locale: string;
  acceptedTerms?: { acceptedAt: Date; contentHash: string };
  returnContext?: { productId: string; courseSessionId: string; location: string; quantity: string };
};

export const deriveGuestAccessToken = (tenantId: string, orderId: string, nonce: string) => {
  if (!OBJECT_ID_PATTERN.test(tenantId) || !OBJECT_ID_PATTERN.test(orderId) ||
      !GUEST_ACCESS_TOKEN_PATTERN.test(nonce)) throw new Error("Invalid guest access context.");
  return digest(`bearer:${tenantId.toLowerCase()}:${orderId.toLowerCase()}:${nonce}`, "base64url");
};

export const createGuestCheckoutAccess = ({
  tenantId, orderId, key, locale, now = new Date(),
}: { tenantId: string; orderId: string; key: string; locale: string; now?: Date }) => {
  // Deterministic only within this secret, tenant and operation. A reclaimed
  // operation must reproduce the original Stripe request after a crash.
  const accessNonce = digest(`nonce:${tenantId}:${orderId}:${key}`, "base64url");
  const accessToken = deriveGuestAccessToken(tenantId, orderId, accessNonce);
  const snapshot: GuestCourseCheckoutSnapshot = {
    version: 1, accessNonce, accessTokenHash: hashGuestAccessToken(accessToken),
    accessExpiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    locale: normalizeCommerceLocale(locale),
  };
  return { accessToken, snapshot };
};

export const verifyGuestCheckoutAccess = (
  token: unknown,
  snapshot: Partial<GuestCourseCheckoutSnapshot> | null | undefined,
  now = new Date(),
): boolean => {
  if (typeof token !== "string" || !GUEST_ACCESS_TOKEN_PATTERN.test(token) ||
      snapshot?.version !== 1 || !/^[a-f0-9]{64}$/.test(snapshot.accessTokenHash || "")) return false;
  const expiry = new Date(snapshot.accessExpiresAt || "");
  if (!Number.isFinite(expiry.getTime()) || expiry <= now) return false;
  return timingSafeEqual(Buffer.from(snapshot.accessTokenHash!, "hex"),
    Buffer.from(hashGuestAccessToken(token), "hex"));
};

export const buildGuestCheckoutReturnUrl = ({
  origin, locale, path, orderId, accessToken, context,
}: {
  origin: string; locale: string; path: "checkout/success" | "checkout/cancel";
  orderId: string; accessToken: string;
  context: { productId: string; courseSessionId: string; location: string; quantity: string };
}) => {
  const url = new URL(buildTenantCommerceUrl({
    origin, locale: normalizeCommerceLocale(locale), path, query: { orderId, ...context },
  }));
  url.hash = new URLSearchParams({ access_token: accessToken }).toString();
  return url.toString();
};

export type GuestCheckoutContext = {
  orderSnapshot: GuestCourseCheckoutSnapshot;
  successUrl: string;
  cancelUrl: string;
};
