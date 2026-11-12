import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
} from "@/modules/checkout/checkout.urls.js";
import { AppError } from "@/shared/http/AppError.js";

export const VOUCHER_PURCHASE_ACCESS_DAYS = 365;
export const VOUCHER_ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const PURPOSE = "shario:voucher-purchase-access:v1";

type AccessContext = { tenantId: string; couponOrderId: string };

const accessSecret = (): string => {
  const secret = process.env.ACCESS_TOKEN_SECRET || "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new AppError({
      statusCode: 503,
      code: "VOUCHER_ACCESS_CONFIGURATION_REQUIRED",
      message:
        "Voucher purchase access requires a configured authentication secret.",
    });
  }
  return secret;
};

export const hashVoucherPurchaseAccessToken = (accessToken: string): string =>
  createHash("sha256").update(`${PURPOSE}:proof:${accessToken}`).digest("hex");

export const deriveVoucherPurchaseAccessToken = ({
  tenantId,
  couponOrderId,
  nonce,
}: AccessContext & { nonce: string }): string => {
  if (
    !OBJECT_ID_PATTERN.test(tenantId) ||
    !OBJECT_ID_PATTERN.test(couponOrderId) ||
    !VOUCHER_ACCESS_TOKEN_PATTERN.test(nonce)
  ) {
    throw new Error("Invalid voucher purchase access context.");
  }
  return createHmac("sha256", accessSecret())
    .update(
      `${PURPOSE}:bearer:${tenantId.toLowerCase()}:${couponOrderId.toLowerCase()}:${nonce}`,
    )
    .digest("base64url");
};

/** Only the nonce and a one-way token hash are persisted; never the bearer token. */
export const createVoucherPurchaseAccess = ({
  tenantId,
  couponOrderId,
  now = new Date(),
}: AccessContext & { now?: Date }) => {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid voucher access issue date.");
  const purchaseAccessNonce = randomBytes(32).toString("base64url");
  const accessToken = deriveVoucherPurchaseAccessToken({
    tenantId,
    couponOrderId,
    nonce: purchaseAccessNonce,
  });
  return {
    accessToken,
    purchaseAccessNonce,
    purchaseAccessTokenHash: hashVoucherPurchaseAccessToken(accessToken),
    purchaseAccessExpiresAt: new Date(
      now.getTime() + VOUCHER_PURCHASE_ACCESS_DAYS * 24 * 60 * 60 * 1000,
    ),
  };
};

export const verifyVoucherPurchaseAccessToken = ({
  accessToken,
  tokenHash,
  expiresAt,
  now = new Date(),
}: {
  accessToken: unknown;
  tokenHash: unknown;
  expiresAt: unknown;
  now?: Date;
}): boolean => {
  if (
    typeof accessToken !== "string" ||
    !VOUCHER_ACCESS_TOKEN_PATTERN.test(accessToken)
  )
    return false;
  if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(tokenHash))
    return false;
  const expiry =
    expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt || ""));
  if (!Number.isFinite(expiry.getTime()) || expiry <= now) return false;
  return timingSafeEqual(
    Buffer.from(tokenHash, "hex"),
    Buffer.from(hashVoucherPurchaseAccessToken(accessToken), "hex"),
  );
};

export type VoucherPurchaseAccessOrder = {
  _id: unknown;
  tenant: unknown;
  purchaseAccessNonce?: string;
  purchaseAccessTokenHash?: string;
  purchaseAccessExpiresAt?: Date | string | null;
  purchaseOriginSnapshot?: string;
  localeSnapshot?: string;
};

/** The secret stays in the URL fragment, outside HTTP paths, queries and referrers. */
export const buildVoucherPurchaseAccessUrl = (
  order: VoucherPurchaseAccessOrder,
  now = new Date(),
): string | undefined => {
  if (!order.purchaseAccessNonce || !order.purchaseOriginSnapshot)
    return undefined;
  const accessToken = deriveVoucherPurchaseAccessToken({
    tenantId: String(order.tenant),
    couponOrderId: String(order._id),
    nonce: order.purchaseAccessNonce,
  });
  if (
    !verifyVoucherPurchaseAccessToken({
      accessToken,
      tokenHash: order.purchaseAccessTokenHash,
      expiresAt: order.purchaseAccessExpiresAt,
      now,
    })
  )
    return undefined;
  const url = new URL(
    buildTenantCommerceUrl({
      origin: order.purchaseOriginSnapshot,
      locale: normalizeCommerceLocale(order.localeSnapshot),
      path: "vouchers/success",
      query: { couponOrderId: String(order._id) },
    }),
  );
  url.hash = new URLSearchParams({ accessToken }).toString();
  return url.toString();
};
