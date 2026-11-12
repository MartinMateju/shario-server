import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";

import {
  ACCESS_CODE_SOURCE,
  ACCESS_CODE_STATUS,
  ACCESS_CODE_TYPE,
  DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD,
} from "../access-code.constants.js";
import {
  decryptAccessCode,
  encryptAccessCode,
  fingerprintAccessCode,
  isEncryptedAccessCode,
  maskAccessCode,
  normalizeAccessCodeValue,
} from "../access-code.crypto.js";
import {
  AccessCode,
  AccessCodeAuditEvent,
  AccessCodePool,
} from "../access-code.model.js";

const APPLY_FLAG = "--apply";
const DEFAULT_POOL_NAME = "Main entrance";
const DEFAULT_POOL_NORMALIZED_NAME = DEFAULT_POOL_NAME.toLocaleLowerCase();
const SAMPLE_LIMIT = 25;
const shouldApply = process.argv.includes(APPLY_FLAG);

type RawAccessCode = {
  _id: unknown;
  tenant?: unknown;
  location?: unknown;
  pool?: unknown;
  entryCode?: unknown;
  codeFingerprint?: unknown;
  expiresAt?: unknown;
  canBeRepeated?: unknown;
  isUsed?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  source?: unknown;
};

type MigrationCounters = {
  scanned: number;
  eligible: number;
  migrated: number;
  wouldMigrate: number;
  alreadyMigrated: number;
  malformed: number;
  failed: number;
  changedConcurrently: number;
  poolsExisting: number;
  poolsCreated: number;
  poolsWouldCreate: number;
};

const counters: MigrationCounters = {
  scanned: 0,
  eligible: 0,
  migrated: 0,
  wouldMigrate: 0,
  alreadyMigrated: 0,
  malformed: 0,
  failed: 0,
  changedConcurrently: 0,
  poolsExisting: 0,
  poolsCreated: 0,
  poolsWouldCreate: 0,
};

const samples = {
  malformedIds: [] as string[],
  failedIds: [] as string[],
  changedConcurrentlyIds: [] as string[],
};

const remember = (target: string[], id: unknown): void => {
  if (target.length < SAMPLE_LIMIT) target.push(String(id ?? "unknown"));
};

const objectIdOrNull = (value: unknown): mongoose.Types.ObjectId | null => {
  if (!value || !mongoose.isValidObjectId(value)) return null;

  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch {
    return null;
  }
};

const optionalDate = (value: unknown): Date | null | undefined => {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const poolCache = new Map<string, mongoose.Types.ObjectId>();
const checkedPoolCache = new Set<string>();

const defaultPoolKey = (
  tenantId: mongoose.Types.ObjectId,
  locationId: mongoose.Types.ObjectId,
): string => `${tenantId.toHexString()}:${locationId.toHexString()}`;

const findDefaultPool = async (
  tenantId: mongoose.Types.ObjectId,
  locationId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId | null> => {
  const pool = await AccessCodePool.collection.findOne(
    {
      tenant: tenantId,
      location: locationId,
      normalizedName: DEFAULT_POOL_NORMALIZED_NAME,
    },
    { projection: { _id: 1 } },
  );

  return objectIdOrNull(pool?._id);
};

const ensureDefaultPool = async (
  tenantId: mongoose.Types.ObjectId,
  locationId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId> => {
  const key = defaultPoolKey(tenantId, locationId);
  const cached = poolCache.get(key);
  if (cached) return cached;

  const existing = await findDefaultPool(tenantId, locationId);
  if (existing) {
    counters.poolsExisting += 1;
    poolCache.set(key, existing);
    return existing;
  }

  if (!shouldApply) {
    const plannedId = new mongoose.Types.ObjectId();
    counters.poolsWouldCreate += 1;
    poolCache.set(key, plannedId);
    return plannedId;
  }

  const now = new Date();
  try {
    const result = await AccessCodePool.collection.updateOne(
      {
        tenant: tenantId,
        location: locationId,
        normalizedName: DEFAULT_POOL_NORMALIZED_NAME,
      },
      {
        $setOnInsert: {
          tenant: tenantId,
          location: locationId,
          name: DEFAULT_POOL_NAME,
          normalizedName: DEFAULT_POOL_NORMALIZED_NAME,
          lowStockThreshold: DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD,
          isActive: true,
          archivedAt: null,
          createdBy: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount > 0) counters.poolsCreated += 1;
  } catch (error) {
    // A concurrent runner can win the unique pool-name upsert. In that case,
    // resolving the pool below keeps this migration idempotent.
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) {
      throw error;
    }
  }

  const created = await findDefaultPool(tenantId, locationId);
  if (!created) {
    throw new Error("The default access-code pool could not be resolved.");
  }

  poolCache.set(key, created);
  return created;
};

const belongsToScope = async ({
  poolId,
  tenantId,
  locationId,
}: {
  poolId: mongoose.Types.ObjectId;
  tenantId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
}): Promise<boolean> => {
  const key = `${poolId.toHexString()}:${defaultPoolKey(tenantId, locationId)}`;
  if (checkedPoolCache.has(key)) return true;

  const exists = await AccessCodePool.collection.findOne(
    { _id: poolId, tenant: tenantId, location: locationId },
    { projection: { _id: 1 } },
  );
  if (!exists) return false;

  checkedPoolCache.add(key);
  return true;
};

const isFullyMigrated = (document: RawAccessCode): boolean =>
  Boolean(
    objectIdOrNull(document.pool) &&
      isEncryptedAccessCode(document.entryCode) &&
      typeof document.codeFingerprint === "string" &&
      document.codeFingerprint.trim(),
  );

const migrateDocument = async (document: RawAccessCode): Promise<void> => {
  counters.scanned += 1;
  const id = objectIdOrNull(document._id);
  const tenantId = objectIdOrNull(document.tenant);
  const locationId = objectIdOrNull(document.location);
  const providedPoolId = objectIdOrNull(document.pool);
  const hasPoolValue = document.pool !== undefined && document.pool !== null;
  const expiresAt = optionalDate(document.expiresAt);
  const storedCode = normalizeAccessCodeValue(document.entryCode);

  if (
    !id ||
    !tenantId ||
    !locationId ||
    !storedCode ||
    expiresAt === undefined ||
    (hasPoolValue && !providedPoolId)
  ) {
    counters.malformed += 1;
    remember(samples.malformedIds, document._id);
    return;
  }

  if (
    providedPoolId &&
    !(await belongsToScope({ poolId: providedPoolId, tenantId, locationId }))
  ) {
    counters.malformed += 1;
    remember(samples.malformedIds, document._id);
    return;
  }

  if (isFullyMigrated(document)) {
    counters.alreadyMigrated += 1;
    return;
  }

  // Modern manual/import records should never need this legacy field mapping.
  // If one is incomplete, leave it untouched for explicit operator review.
  if (
    providedPoolId &&
    (document.source === ACCESS_CODE_SOURCE.MANUAL ||
      document.source === ACCESS_CODE_SOURCE.IMPORT)
  ) {
    counters.malformed += 1;
    remember(samples.malformedIds, document._id);
    return;
  }

  counters.eligible += 1;

  try {
    const poolId =
      providedPoolId || (await ensureDefaultPool(tenantId, locationId));
    const plaintextCode = isEncryptedAccessCode(storedCode)
      ? decryptAccessCode({
          tenantId: tenantId.toHexString(),
          poolId: poolId.toHexString(),
          encryptedEntryCode: storedCode,
        })
      : storedCode;

    // Compute these even in dry-run mode so invalid key configuration and
    // malformed encrypted values fail before an operator starts the apply run.
    const encryptedCode = encryptAccessCode({
      tenantId: tenantId.toHexString(),
      poolId: poolId.toHexString(),
      entryCode: plaintextCode,
    });
    const codeFingerprint = fingerprintAccessCode({
      tenantId: tenantId.toHexString(),
      poolId: poolId.toHexString(),
      entryCode: plaintextCode,
    });

    if (!shouldApply) {
      counters.wouldMigrate += 1;
      return;
    }

    const isUsed = document.isUsed === true;
    const canBeRepeated = document.canBeRepeated === true;
    const now = new Date();
    const createdAt = optionalDate(document.createdAt);
    const updatedAt = optionalDate(document.updatedAt);
    const result = await AccessCode.collection.updateOne(
      { _id: id, entryCode: document.entryCode },
      {
        $set: {
          pool: poolId,
          entryCode: encryptedCode,
          codeFingerprint,
          codeHint: maskAccessCode(plaintextCode),
          type: canBeRepeated
            ? ACCESS_CODE_TYPE.REUSABLE
            : ACCESS_CODE_TYPE.SINGLE_BOOKING,
          status: isUsed
            ? ACCESS_CODE_STATUS.RETIRED
            : ACCESS_CODE_STATUS.AVAILABLE,
          source: ACCESS_CODE_SOURCE.LEGACY_MIGRATION,
          validFrom: null,
          validUntil: expiresAt,
          verifiedAt: createdAt || now,
          verifiedBy: null,
          retiredAt: isUsed ? updatedAt || now : null,
          emergencyReserveKey: null,
          updatedBy: null,
          updatedAt: now,
        },
      },
    );

    if (result.matchedCount === 0) {
      counters.changedConcurrently += 1;
      remember(samples.changedConcurrentlyIds, document._id);
      return;
    }
    counters.migrated += 1;
  } catch {
    counters.failed += 1;
    remember(samples.failedIds, document._id);
  }
};

const findLegacyIndex = async (): Promise<string | null> => {
  try {
    const indexes = await AccessCode.collection.listIndexes().toArray();
    const legacy = indexes.find((index) => {
      const keys = Object.entries(index.key);
      return (
        index.name === "tenant_1_entryCode_1" ||
        (keys.length === 2 &&
          index.key.tenant === 1 &&
          index.key.entryCode === 1)
      );
    });
    return legacy?.name || null;
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      (error.code === 26 || error.codeName === "NamespaceNotFound")
    ) {
      return null;
    }
    throw error;
  }
};

const dropLegacyIndex = async (indexName: string | null): Promise<boolean> => {
  if (!indexName) return false;

  try {
    await AccessCode.collection.dropIndex(indexName);
    return true;
  } catch (error) {
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      (error.code === 26 ||
        error.code === 27 ||
        error.codeName === "NamespaceNotFound" ||
        error.codeName === "IndexNotFound")
    ) {
      return false;
    }
    throw error;
  }
};

const run = async (): Promise<void> => {
  await connectDB();

  // This uses a synthetic value and never a stored door code. It provides an
  // immediate, clear failure when the independent encryption key is missing.
  fingerprintAccessCode({
    tenantId: new mongoose.Types.ObjectId().toHexString(),
    poolId: new mongoose.Types.ObjectId().toHexString(),
    entryCode: "migration-configuration-check",
  });

  const cursor = AccessCode.collection.find({});
  for await (const document of cursor) {
    await migrateDocument(document as RawAccessCode);
  }

  const legacyIndexName = await findLegacyIndex();
  let legacyIndexDropped = false;
  const indexesEnsured: string[] = [];

  if (shouldApply) {
    legacyIndexDropped = await dropLegacyIndex(legacyIndexName);

    // Additive and idempotent: unlike syncIndexes(), createIndexes() never
    // removes unrelated production indexes.
    for (const model of [AccessCodePool, AccessCode, AccessCodeAuditEvent]) {
      await model.createIndexes();
      indexesEnsured.push(model.modelName);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        migration: "access-code-inventory-v1",
        mode: shouldApply ? "apply" : "dry-run",
        counters,
        samples,
        sampleLimit: SAMPLE_LIMIT,
        legacyIndex: {
          found: legacyIndexName,
          dropped: legacyIndexDropped,
        },
        indexesEnsured,
      },
      null,
      2,
    )}\n`,
  );
};

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Access-code inventory migration failed: ${message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
