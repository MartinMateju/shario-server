import { createHash } from "node:crypto";
import mongoose from "mongoose";

import { badRequest } from "@/shared/http/httpErrors.js";

export const CREDIT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export const validateCreditIdempotencyKey = (value: unknown): string => {
  const key = typeof value === "string" ? value.trim() : "";

  if (!CREDIT_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    badRequest({
      message: "A valid Idempotency-Key header is required.",
      code: "CREDIT_IDEMPOTENCY_KEY_REQUIRED",
    });
  }

  return key;
};

export const sha256CreditValue = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const canonicalize = (value: unknown): unknown => {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(canonicalize);

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

export const hashCreditMutationRequest = (value: unknown): string =>
  sha256CreditValue(JSON.stringify(canonicalize(value)));

export const buildLedgerIdempotencyKey = ({
  actorUserId,
  keyHash,
}: {
  actorUserId: string;
  keyHash: string;
}): string => `direct:${actorUserId}:${keyHash}`;
