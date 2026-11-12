import { createHash, randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";

import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import {
  CHECKOUT_OPERATION_RETENTION_MS,
  CheckoutOperationModel,
} from "./checkout-operation.model.js";

const CHECKOUT_LEASE_MS = 10 * 60 * 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export type CheckoutKind = "card" | "credits";

export type CheckoutOperationLease = {
  operationId: string;
  orderId: mongoose.Types.ObjectId;
  cartId: mongoose.Types.ObjectId;
  leaseToken: string;
};

export type CheckoutOperationAcquisition =
  | { type: "acquired"; lease: CheckoutOperationLease }
  | { type: "replay"; response: any };

const sha256 = (value: string): string =>
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

export const hashCheckoutRequest = (value: unknown): string =>
  sha256(JSON.stringify(canonicalize(value)));

export const validateCheckoutIdempotencyKey = (value: unknown): string => {
  const key = typeof value === "string" ? value.trim() : "";

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    badRequest({
      message: "A valid Idempotency-Key header is required.",
      code: "CHECKOUT_IDEMPOTENCY_KEY_REQUIRED",
    });
  }

  return key;
};

const isDuplicateKey = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: number }).code === 11000,
  );

const inspectExisting = async (
  operation: any,
  requestHash: string,
): Promise<CheckoutOperationAcquisition> => {
  if (operation.requestHash !== requestHash) {
    conflict({
      message: "This idempotency key was used for a different checkout.",
      code: "CHECKOUT_IDEMPOTENCY_KEY_CONFLICT",
    });
  }

  if (operation.state === "completed" && operation.response) {
    return { type: "replay", response: operation.response };
  }

  const now = new Date();
  if (new Date(operation.leaseExpiresAt) > now) {
    conflict({
      message: "This checkout is already being processed.",
      code: "CHECKOUT_IDEMPOTENCY_IN_PROGRESS",
    });
  }

  const leaseToken = randomUUID();
  const reclaimed = await CheckoutOperationModel.findOneAndUpdate(
    {
      _id: operation._id,
      state: "processing",
      requestHash,
      leaseExpiresAt: { $lte: now },
    },
    {
      $set: {
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + CHECKOUT_LEASE_MS),
        expiresAt: new Date(now.getTime() + CHECKOUT_OPERATION_RETENTION_MS),
      },
    },
    { returnDocument: "after" },
  ).exec();

  if (!reclaimed) {
    const current = await CheckoutOperationModel.findById(operation._id).exec();
    if (current?.state === "completed" && current.response) {
      return { type: "replay", response: current.response };
    }

    conflict({
      message: "This checkout is already being processed.",
      code: "CHECKOUT_IDEMPOTENCY_IN_PROGRESS",
    });
  }

  return {
    type: "acquired",
    lease: {
      operationId: String(reclaimed._id),
      orderId: reclaimed.orderId,
      cartId: reclaimed.cartId,
      leaseToken,
    },
  };
};

export const acquireCheckoutOperation = async (input: {
  tenantId: string;
  userId: string;
  kind: CheckoutKind;
  idempotencyKey: unknown;
  request: unknown;
}): Promise<CheckoutOperationAcquisition> => {
  const key = validateCheckoutIdempotencyKey(input.idempotencyKey);
  const keyHash = sha256(key);
  const requestHash = hashCheckoutRequest(input.request);
  const namespace = {
    tenant: new mongoose.Types.ObjectId(input.tenantId),
    user: new mongoose.Types.ObjectId(input.userId),
    kind: input.kind,
    keyHash,
  };

  const existing = await CheckoutOperationModel.findOne(namespace).exec();
  if (existing) return inspectExisting(existing, requestHash);

  const now = Date.now();
  const leaseToken = randomUUID();

  try {
    const operation = await CheckoutOperationModel.create({
      ...namespace,
      requestHash,
      orderId: new mongoose.Types.ObjectId(),
      cartId: new mongoose.Types.ObjectId(),
      state: "processing",
      leaseToken,
      leaseExpiresAt: new Date(now + CHECKOUT_LEASE_MS),
      expiresAt: new Date(now + CHECKOUT_OPERATION_RETENTION_MS),
    });

    return {
      type: "acquired",
      lease: {
        operationId: String(operation._id),
        orderId: operation.orderId,
        cartId: operation.cartId,
        leaseToken,
      },
    };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;

    const concurrent = await CheckoutOperationModel.findOne(namespace).exec();
    if (!concurrent) throw error;
    return inspectExisting(concurrent, requestHash);
  }
};

export const completeCheckoutOperation = async (
  lease: CheckoutOperationLease,
  response: unknown,
  session: ClientSession | null = null,
): Promise<void> => {
  const result = await CheckoutOperationModel.updateOne(
    {
      _id: lease.operationId,
      leaseToken: lease.leaseToken,
      state: "processing",
    },
    {
      $set: {
        state: "completed",
        response,
        expiresAt: new Date(Date.now() + CHECKOUT_OPERATION_RETENTION_MS),
      },
    },
    { session },
  ).exec();

  if (result.modifiedCount !== 1) {
    conflict({
      message: "The checkout operation lease is no longer owned.",
      code: "CHECKOUT_IDEMPOTENCY_LEASE_LOST",
    });
  }
};

export const releaseCheckoutOperation = async (
  lease: CheckoutOperationLease,
): Promise<void> => {
  await CheckoutOperationModel.updateOne(
    {
      _id: lease.operationId,
      leaseToken: lease.leaseToken,
      state: "processing",
    },
    { $set: { leaseExpiresAt: new Date(0) } },
  ).exec();
};
