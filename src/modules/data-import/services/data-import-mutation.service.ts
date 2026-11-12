import { createHash } from "node:crypto";

import mongoose from "mongoose";

import {
  DATA_IMPORT_MUTATION_OPERATION,
  type DataImportEntity,
} from "../data-import.constants.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";

type Snapshot = { values: Record<string, unknown>; present: string[] };

const hasOwnPath = (source: unknown, path: string): boolean => {
  let current = source as Record<string, unknown> | null;
  for (const part of path.split(".")) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, part))
      return false;
    current = current[part] as Record<string, unknown> | null;
  }
  return true;
};

const valueAtPath = (source: unknown, path: string): unknown => {
  let current = source as Record<string, unknown> | null;
  for (const part of path.split(".")) {
    if (!current) return undefined;
    current = current[part] as Record<string, unknown> | null;
  }
  return current;
};

const updatedAtOf = (record: unknown): Date | null => {
  const value = valueAtPath(record, "updatedAt");
  return value ? new Date(value as string | Date) : null;
};

const plain = (value: unknown): unknown => {
  if (value instanceof Date) return new Date(value);
  if (value instanceof mongoose.Types.ObjectId)
    return new mongoose.Types.ObjectId(value.toHexString());
  if (value instanceof mongoose.Types.Decimal128)
    return mongoose.Types.Decimal128.fromString(value.toString());
  if (value instanceof Map)
    return Object.fromEntries(
      [...value.entries()].map(([key, nested]) => [String(key), plain(nested)]),
    );
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const source =
      typeof (value as { toObject?: unknown }).toObject === "function"
        ? (value as { toObject: () => unknown }).toObject()
        : value;
    return Object.fromEntries(
      Object.entries(source as Record<string, unknown>).map(([key, nested]) => [
        key,
        plain(nested),
      ]),
    );
  }
  return value;
};

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof mongoose.Types.ObjectId)
    return { $oid: value.toHexString() };
  if (value instanceof mongoose.Types.Decimal128)
    return { $decimal: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
};

export const dataImportMutationHash = (snapshot: Snapshot): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(snapshot)))
    .digest("hex");

export const verifyDataImportMutationPayload = (mutation: any): boolean => {
  if (Number(mutation?.schemaVersion) !== 1) return false;
  const immutablePayload = {
    schemaVersion: 1,
    tenant: String(mutation.tenant),
    session: String(mutation.session),
    row: mutation.row,
    mutationKey: mutation.mutationKey,
    rowNumber: Number(mutation.rowNumber),
    entityType: mutation.entityType,
    operation: mutation.operation,
    importOutcome: mutation.importOutcome,
    importMessage: mutation.importMessage,
    isCanonicalResult: Boolean(mutation.isCanonicalResult),
    targetId: String(mutation.target),
    targetUpdatedAt: mutation.targetUpdatedAt
      ? new Date(mutation.targetUpdatedAt).toISOString()
      : null,
    fields: [...(mutation.affectedFields || [])],
    before: mutation.before,
    after: mutation.after,
    delta: mutation.delta ?? null,
    actorId: String(mutation.actor),
  };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(canonical(immutablePayload)))
    .digest("hex");
  return (
    payloadHash === mutation.payloadHash &&
    dataImportMutationHash(mutation.after) === mutation.afterHash
  );
};

export const captureImportMutationSnapshot = (
  record: unknown,
  fields: readonly string[],
): Snapshot => {
  const source =
    record && typeof (record as { toObject?: unknown }).toObject === "function"
      ? (
          record as {
            toObject: (options?: Record<string, unknown>) => unknown;
          }
        ).toObject({
          depopulate: true,
          flattenMaps: true,
        })
      : record;
  const present = fields.filter(
    (field) =>
      hasOwnPath(source, field) && valueAtPath(source, field) !== undefined,
  );
  return {
    values: Object.fromEntries(
      present.map((field) => [field, plain(valueAtPath(source, field))]),
    ),
    present,
  };
};

const MAX_JOURNAL_BYTES = 128 * 1024;

const allowedFields: Record<DataImportEntity, readonly string[]> = {
  customers: [
    "firstname",
    "lastname",
    "email",
    "phone",
    "memberNumber",
    "memberNumberHistory",
    "isAccessGranted",
    "importMetadata",
  ],
  products: [
    "name",
    "description",
    "sku",
    "type",
    "kind",
    "kindContractVersion",
    "bookingMode",
    "price",
    "extraCharge",
    "maxNumberOfParticipants",
    "currency",
    "isActive",
    "sortOrder",
    "label",
      "importMetadata",
  ],
  bookings: [
    "createdBy",
    "author",
    "bookingProduct",
    "location",
    "start",
    "end",
    "numberOfHours",
    "numberOfGuests",
    "status",
    "archive",
    "language",
    "plannedActivity",
    "lecturer",
    "description",
    "note",
    "tag",
    "bookingType",
    "bookingMode",
    "importMetadata",
  ],
  "membership-plans": [
    "status",
    "currentPublishedVersion",
    "currentDraftVersion",
    "versionCounter",
    "sortOrder",
    "updatedBy",
    "publishedAt",
    "archivedAt",
    "importMetadata",
    "plan",
    "version",
    "name",
    "description",
    "terms",
    "prices",
    "billing",
    "locationScope",
    "benefits",
  ],
  memberships: [
    "status",
    "isOpen",
    "startedAt",
    "currentPeriodStart",
    "currentPeriodEnd",
    "renewsAt",
    "autoRenew",
    "cancelAtPeriodEnd",
    "cancelScheduledAt",
    "cancelledAt",
    "cancellation",
    "assignmentNote",
    "grantedPeriodKeys",
    "importMetadata",
  ],
  credits: [
    "targetAmountMinor",
    "currency",
    "revision",
    "note",
    "source",
    "importId",
    "lastMutationKey",
    "importedAt",
    "importedBy",
  ],
  "voucher-products": [
    "name",
    "description",
    "sku",
    "type",
    "kind",
    "kindContractVersion",
    "bookingMode",
    "price",
    "currency",
    "isActive",
    "sortOrder",
    "label",
    "importMetadata",
  ],
  vouchers: [
    "product",
    "promoCode",
    "valueMinorSnapshot",
    "currencySnapshot",
    "isActive",
    "singleUse",
    "expiresAt",
    "reservedAt",
    "reservedBy",
    "reservedOrder",
    "reservedUntil",
    "redeemedAt",
    "redeemedBy",
    "order",
    "importMetadata",
  ],
};

const assertSafeAffectedFields = (
  entityType: DataImportEntity,
  fields: readonly string[],
): void => {
  const allowed = allowedFields[entityType];
  for (const field of fields) {
    const segments = field.split(".");
    if (
      !field ||
      field.includes("$") ||
      segments.some(
        (segment) =>
          !segment ||
          ["__proto__", "prototype", "constructor"].includes(segment),
      ) ||
      !allowed.some(
        (prefix) => field === prefix || field.startsWith(`${prefix}.`),
      )
    )
      throw new Error(`Unsafe import rollback field: ${field}`);
  }
};

export const recordDataImportMutation = async ({
  tenantId,
  sessionId,
  rowId,
  rowNumber,
  entityType,
  mutationKey,
  operation,
  importOutcome,
  importMessage,
  isCanonicalResult = true,
  targetId,
  affectedFields,
  beforeRecord,
  afterRecord,
  delta = null,
  actorId,
  transaction,
}: {
  tenantId: string;
  sessionId: string;
  rowId: unknown;
  rowNumber: number;
  entityType: DataImportEntity;
  mutationKey: string;
  operation: (typeof DATA_IMPORT_MUTATION_OPERATION)[keyof typeof DATA_IMPORT_MUTATION_OPERATION];
  importOutcome: "created" | "updated";
  importMessage: string;
  isCanonicalResult?: boolean;
  targetId: unknown;
  affectedFields: readonly string[];
  beforeRecord: unknown;
  afterRecord: unknown;
  delta?: Record<string, unknown> | null;
  actorId: string;
  transaction: mongoose.ClientSession;
}) => {
  const rowObjectId =
    rowId instanceof mongoose.Types.ObjectId
      ? rowId
      : new mongoose.Types.ObjectId(String(rowId));
  const targetObjectId =
    targetId instanceof mongoose.Types.ObjectId
      ? targetId
      : new mongoose.Types.ObjectId(String(targetId));
  const fields = [...new Set(affectedFields)].sort();
  assertSafeAffectedFields(entityType, fields);
  const before = captureImportMutationSnapshot(beforeRecord, fields);
  const after = captureImportMutationSnapshot(afterRecord, fields);
  const serialized = JSON.stringify(canonical({ before, after, delta }));
  if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES)
    throw new Error("Import rollback journal exceeds its safe size limit.");

  const identity = {
    tenant: tenantId,
    session: sessionId,
    row: rowObjectId,
    mutationKey,
  };
  const immutablePayload = {
    schemaVersion: 1,
    ...identity,
    rowNumber,
    entityType,
    operation,
    importOutcome,
    importMessage,
    isCanonicalResult,
    targetId: String(targetObjectId),
    targetUpdatedAt: updatedAtOf(afterRecord)?.toISOString() || null,
    fields,
    before,
    after,
    delta,
    actorId: String(actorId),
  };
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(canonical(immutablePayload)))
    .digest("hex");
  const existing = await DataImportMutationModel.findOne(identity)
    .session(transaction)
    .lean();
  if (existing) {
    if (existing.payloadHash !== payloadHash)
      throw new Error("Import rollback journal identity conflict.");
    return existing;
  }

  const importSession = await DataImportSessionModel.findOne({
    _id: sessionId,
    tenant: tenantId,
  })
    .select("rollbackAvailableUntil")
    .session(transaction)
    .lean();
  if (!importSession?.rollbackAvailableUntil)
    throw new Error("Import rollback retention is unavailable.");

  const created = (await DataImportMutationModel.create(
    [
      {
        ...identity,
        schemaVersion: 1,
        rowNumber,
        entityType,
        operation,
        importOutcome,
        importMessage,
        isCanonicalResult,
        target: targetObjectId,
        targetUpdatedAt: updatedAtOf(afterRecord),
        affectedFields: fields,
        before,
        after,
        afterHash: dataImportMutationHash(after),
        payloadHash,
        delta,
        actor: actorId,
        expiresAt: importSession.rollbackAvailableUntil,
      },
    ],
    { session: transaction },
  )) as any[];
  if (!created[0]) throw new Error("Import rollback journal was not created.");
  return created[0];
};

export const importMutationOperation = DATA_IMPORT_MUTATION_OPERATION;
