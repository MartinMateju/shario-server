import { createHash } from "node:crypto";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value instanceof Date ? value.toISOString() : value;
};

export const membershipIdentityHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");

export const assertMembershipIdempotencyIdentity = (
  existingHash: string,
  requestedHash: string,
): void => {
  if (existingHash !== requestedHash) {
    const error = new Error("Idempotency key was already used for a different membership operation.");
    Object.assign(error, { code: "MEMBERSHIP_IDEMPOTENCY_IDENTITY_MISMATCH", statusCode: 409 });
    throw error;
  }
};

