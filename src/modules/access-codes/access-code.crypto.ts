import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

import { ACCESS_CODE_CIPHERTEXT_PREFIX } from "./access-code.constants.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class AccessCodeEncryptionConfigurationError extends Error {
  readonly code = "ACCESS_CODE_ENCRYPTION_KEY_MISSING";
  readonly statusCode = 503;
  readonly status = "fail";
  readonly isOperational = true;

  constructor(message = "Access-code encryption is not configured.") {
    super(message);
    this.name = "AccessCodeEncryptionConfigurationError";
  }
}

const encryptionKey = (): Buffer => {
  const secret = process.env.ACCESS_CODE_ENCRYPTION_KEY?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < KEY_BYTES) {
    throw new AccessCodeEncryptionConfigurationError(
      "ACCESS_CODE_ENCRYPTION_KEY must contain at least 32 bytes before access codes can be managed.",
    );
  }

  return createHash("sha256").update(secret, "utf8").digest();
};

const context = (tenantId: string, poolId: string): string => {
  const tenant = String(tenantId || "").trim();
  const pool = String(poolId || "").trim();
  if (!tenant || !pool) {
    throw new Error("Access-code encryption requires tenant and pool context.");
  }
  return `${tenant}\u001f${pool}`;
};

export const normalizeAccessCodeValue = (value: unknown): string =>
  String(value ?? "").trim();

export const maskAccessCode = (value: unknown): string => {
  const normalized = normalizeAccessCodeValue(value);
  if (!normalized) return "••••";
  if (normalized.length <= 2) return "•".repeat(normalized.length);
  return `${"•".repeat(Math.min(6, Math.max(4, normalized.length - 2)))}${normalized.slice(-2)}`;
};

export const fingerprintAccessCode = ({
  tenantId,
  poolId,
  entryCode,
}: {
  tenantId: string;
  poolId: string;
  entryCode: string;
}): string => {
  const normalized = normalizeAccessCodeValue(entryCode);
  if (!normalized) throw new Error("Access code is required.");

  return createHmac("sha256", encryptionKey())
    .update(context(tenantId, poolId), "utf8")
    .update("\u001f", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
};

export const encryptAccessCode = ({
  tenantId,
  poolId,
  entryCode,
}: {
  tenantId: string;
  poolId: string;
  entryCode: string;
}): string => {
  const normalized = normalizeAccessCodeValue(entryCode);
  if (!normalized) throw new Error("Access code is required.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context(tenantId, poolId), "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(normalized, "utf8"),
    cipher.final(),
  ]);

  return [
    ACCESS_CODE_CIPHERTEXT_PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
};

export const decryptAccessCode = ({
  tenantId,
  poolId,
  encryptedEntryCode,
}: {
  tenantId: string;
  poolId: string;
  encryptedEntryCode: string;
}): string => {
  const [version, ivValue, tagValue, encryptedValue, ...extra] = String(
    encryptedEntryCode || "",
  ).split(":");

  if (
    version !== ACCESS_CODE_CIPHERTEXT_PREFIX ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra.length
  ) {
    throw new Error("Invalid encrypted access-code format.");
  }

  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error("Invalid encrypted access-code payload.");
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAAD(Buffer.from(context(tenantId, poolId), "utf8"));
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export const isEncryptedAccessCode = (value: unknown): boolean =>
  String(value || "").startsWith(`${ACCESS_CODE_CIPHERTEXT_PREFIX}:`);
