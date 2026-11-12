import { AppError } from "@/shared/http/AppError.js";

import {
  DATA_IMPORT_ENTITY,
  type DataImportEntity,
} from "../data-import.constants.js";
import { commerceImportIndexesReady } from "../commerce-import-index.migration.js";

const commerceEntities = new Set<DataImportEntity>([
  DATA_IMPORT_ENTITY.MEMBERSHIP_PLANS,
  DATA_IMPORT_ENTITY.MEMBERSHIPS,
  DATA_IMPORT_ENTITY.CREDITS,
  DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
  DATA_IMPORT_ENTITY.VOUCHERS,
]);

const READINESS_CACHE_MS = 30_000;
let cachedReadyUntil = 0;

export const isCommerceImportEntity = (entityType: DataImportEntity): boolean =>
  commerceEntities.has(entityType);

export const clearCommerceImportReadinessCache = (): void => {
  cachedReadyUntil = 0;
};

export const assertCommerceImportReady = async (
  entityType: DataImportEntity,
  {
    now = Date.now(),
    checkIndexes = commerceImportIndexesReady,
  }: {
    now?: number;
    checkIndexes?: () => Promise<boolean>;
  } = {},
): Promise<void> => {
  const commerceEntity = isCommerceImportEntity(entityType);
  if (commerceEntity && process.env.DATA_IMPORT_COMMERCE_ENABLED !== "true") {
    throw new AppError({
      statusCode: 503,
      code: "IMPORT_COMMERCE_NOT_ENABLED",
      message:
        "Membership, credit, and voucher imports are not enabled for this deployment.",
    });
  }

  if (cachedReadyUntil > now) return;
  if (!(await checkIndexes())) {
    throw new AppError({
      statusCode: 503,
      code: commerceEntity
        ? "IMPORT_COMMERCE_INDEXES_NOT_READY"
        : "IMPORT_ROLLBACK_INDEXES_NOT_READY",
      message:
        "Data import indexes are not ready. Run the commerce import index migration before enabling imports.",
    });
  }
  cachedReadyUntil = now + READINESS_CACHE_MS;
};
