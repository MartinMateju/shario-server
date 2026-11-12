import { createHash } from "node:crypto";

import ProductModel from "@/modules/product/product.model.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import type {
  ImportIssue,
  NormalizedProductImportRow,
  ProductImportColumnMapping,
} from "../data-import.types.js";
import {
  normalizeProductImportRow,
  productFileIdentityKeys,
  validateProductImportRow,
} from "../adapters/product-import.adapter.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  createDataImportSession,
  getTenantImportSession,
  serializeImportSession,
} from "./data-import.service.js";
import { assertValidProductColumnMapping } from "./import-column-mapping.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

export const createProductImportSession = async (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({ ...args, entityType: DATA_IMPORT_ENTITY.PRODUCTS });

type ExistingProduct = {
  _id: any;
  name?: string;
  sku?: string;
  kind?: string;
  type?: string;
  description?: string;
  price?: number;
  extraCharge?: number;
  currency?: string;
  maxNumberOfParticipants?: number | null;
  bookingMode?: "public" | "private" | null;
  isActive?: boolean;
  isArchived?: boolean;
  sortOrder?: number;
  importMetadata?: { externalId?: string; importKey?: string };
};

const resolvedExistingKind = (product: ExistingProduct): string => {
  if (product.kind) return product.kind;
  if (
    ["workshop", "public-workshop", "private-workshop"].includes(
      String(product.type),
    )
  )
    return "open-studio";
  if (
    ["course", "public-course", "private-course"].includes(String(product.type))
  )
    return "class";
  if (["blocker", "private-studio"].includes(String(product.type)))
    return "private-studio";
  return "";
};

const effectiveProductUpdate = (
  normalized: NormalizedProductImportRow,
  existing: ExistingProduct,
): NormalizedProductImportRow => {
  const provided = new Set(normalized.providedFields);
  return {
    ...normalized,
    description: provided.has("description")
      ? normalized.description
      : String(existing.description || ""),
    sku: provided.has("sku") ? normalized.sku : String(existing.sku || ""),
    price: provided.has("price")
      ? normalized.price
      : Number(existing.price ?? 0),
    extraCharge: provided.has("extraCharge")
      ? normalized.extraCharge
      : Number(existing.extraCharge ?? 0),
    currency: provided.has("currency")
      ? normalized.currency
      : String(existing.currency || normalized.currency),
    capacity: provided.has("capacity")
      ? normalized.capacity
      : (existing.maxNumberOfParticipants ?? null),
    bookingMode: provided.has("bookingMode")
      ? normalized.bookingMode
      : (existing.bookingMode ?? null),
    isActive: provided.has("isActive")
      ? normalized.isActive
      : (existing.isActive ?? true),
    sortOrder: provided.has("sortOrder")
      ? normalized.sortOrder
      : (existing.sortOrder ?? 0),
  };
};

const addToMultiMap = <T>(map: Map<string, T[]>, key: string, value: T) => {
  if (!key) return;
  map.set(key, [...(map.get(key) || []), value]);
};

export const buildProductIndexes = (products: ExistingProduct[]) => {
  const externalIds = new Map<string, ExistingProduct[]>();
  const skus = new Map<string, ExistingProduct[]>();
  const names = new Map<string, ExistingProduct[]>();
  for (const product of products) {
    addToMultiMap(
      externalIds,
      String(product.importMetadata?.externalId || "").trim(),
      product,
    );
    addToMultiMap(
      skus,
      String(product.sku || "")
        .trim()
        .toLocaleLowerCase(),
      product,
    );
    addToMultiMap(
      names,
      String(product.name || "")
        .trim()
        .toLocaleLowerCase(),
      product,
    );
  }
  return { externalIds, skus, names };
};

const findProductDuplicate = (
  row: NormalizedProductImportRow,
  indexes: ReturnType<typeof buildProductIndexes>,
) => {
  const matches = new Map<string, { record: ExistingProduct; kind: string }>();
  let ambiguous = false;
  const inspect = (records: ExistingProduct[] | undefined, kind: string) => {
    if (!records?.length) return;
    if (records.length > 1) ambiguous = true;
    for (const record of records)
      matches.set(String(record._id), { record, kind });
  };
  if (row.externalId)
    inspect(indexes.externalIds.get(row.externalId), "externalId");
  if (row.sku) inspect(indexes.skus.get(row.sku.toLocaleLowerCase()), "sku");
  if (row.name)
    inspect(indexes.names.get(row.name.toLocaleLowerCase()), "name");
  if (ambiguous || matches.size > 1) return { duplicate: null, conflict: true };
  const match = [...matches.values()][0];
  return {
    duplicate: match
      ? {
          kind: match.kind,
          existingRecordId: match.record._id,
          record: match.record,
        }
      : null,
    conflict: false,
  };
};

const emptySummary = (total: number) => ({
  total,
  valid: 0,
  warnings: 0,
  invalid: 0,
  duplicates: 0,
  toCreate: 0,
  toUpdate: 0,
  toSkip: 0,
  created: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
});

const moduleForProduct = (kind: string): "bookings" | "courses" =>
  kind === "class" ? "courses" : "bookings";

export const validateProductImportSession = async ({
  tenantId,
  sessionId,
  mapping: mappingInput,
  duplicateStrategy,
  actorId,
  tenantCurrency,
  enabledModules,
}: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
  enabledModules: ReadonlySet<string>;
}) => {
  if (
    !Object.values(DATA_IMPORT_DUPLICATE_STRATEGY).includes(duplicateStrategy)
  ) {
    badRequest({
      message: "Duplicate strategy must be skip or update.",
      code: "IMPORT_DUPLICATE_STRATEGY_INVALID",
    });
  }
  const current = await getTenantImportSession({ tenantId, sessionId });
  if (
    current.entityType !== DATA_IMPORT_ENTITY.PRODUCTS ||
    ![
      DATA_IMPORT_STATUS.UPLOADED,
      DATA_IMPORT_STATUS.VALIDATED,
      DATA_IMPORT_STATUS.FAILED,
    ].includes(current.status as never)
  ) {
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
      details: { status: current.status },
    });
  }
  const mapping: ProductImportColumnMapping = assertValidProductColumnMapping(
    current.headers,
    mappingInput,
  );
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: current._id,
      tenant: tenantId,
      entityType: DATA_IMPORT_ENTITY.PRODUCTS,
      status: {
        $in: [
          DATA_IMPORT_STATUS.UPLOADED,
          DATA_IMPORT_STATUS.VALIDATED,
          DATA_IMPORT_STATUS.FAILED,
        ],
      },
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.VALIDATING,
        lastError: null,
        completedAt: null,
      },
    },
    { returnDocument: "after" },
  ).lean();
  if (!session)
    conflict({
      message: "This import can no longer be validated.",
      code: "IMPORT_STATE_INVALID",
    });

  try {
    const [rows, products] = await Promise.all([
      DataImportRowModel.find({ tenant: tenantId, session: current._id })
        .sort({ rowNumber: 1 })
        .lean(),
      ProductModel.find({ tenant: tenantId })
        .select(
          "_id name description sku kind type bookingMode price extraCharge currency maxNumberOfParticipants studioFlow isActive isArchived sortOrder +importMetadata",
        )
        .lean(),
    ]);
    const indexes = buildProductIndexes(products as ExistingProduct[]);
    const fileKeys = new Map<string, number>();
    const summary = emptySummary(rows.length);
    const operations: any[] = [];

    for (const row of rows) {
      const normalized = normalizeProductImportRow(
        row.raw as Record<string, string>,
        mapping,
        tenantCurrency,
      );
      const existing = findProductDuplicate(normalized, indexes);
      let duplicate: any = existing.duplicate;
      const effective = existing.duplicate?.record
        ? effectiveProductUpdate(normalized, existing.duplicate.record)
        : normalized;
      const issues = validateProductImportRow(effective, tenantCurrency);
      if (existing.duplicate?.record?.isArchived) issues.push({
        code: "PRODUCT_ARCHIVED", severity: "error", message: "Archived studio products cannot be updated by an import.",
      });
      if (isRolledBackImportRecord(existing.duplicate?.record))
        issues.push({ ...rolledBackImportIssue });
      if (
        normalized.kind &&
        !enabledModules.has(moduleForProduct(normalized.kind))
      ) {
        issues.push({
          code: "PRODUCT_MODULE_DISABLED",
          field: "kind",
          severity: "error",
          message: `The ${moduleForProduct(normalized.kind)} module must be enabled for this product.`,
        });
      }
      if (existing.conflict)
        issues.push({
          code: "PRODUCT_IDENTITY_CONFLICT",
          severity: "error",
          message: "Product identifiers match different or ambiguous records.",
        });
      if (
        existing.duplicate?.record &&
        resolvedExistingKind(existing.duplicate.record) !== normalized.kind
      ) {
        issues.push({
          code: "PRODUCT_KIND_UPDATE_FORBIDDEN",
          field: "kind",
          severity: "error",
          message: "An import cannot change an existing product kind.",
        });
      }

      const keys = productFileIdentityKeys(normalized);
      if (!issues.some((issue) => issue.severity === "error")) {
        const earlier = new Set(
          keys
            .map((key) => fileKeys.get(`${key.kind}:${key.value}`))
            .filter((value): value is number => value !== undefined),
        );
        if (earlier.size > 1) {
          issues.push({
            code: "PRODUCT_IDENTITY_CONFLICT",
            severity: "error",
            message: "Product identifiers match different rows in this file.",
          });
        } else if (earlier.size === 1) {
          const identityRow = [...earlier][0];
          duplicate = { kind: "file", rowNumber: identityRow };
          issues.push({
            code: "PRODUCT_DUPLICATE_IN_FILE",
            severity: "warning",
            message: "This product already appears earlier in the file.",
          });
          for (const key of keys)
            if (!fileKeys.has(`${key.kind}:${key.value}`))
              fileKeys.set(`${key.kind}:${key.value}`, identityRow);
        } else {
          for (const key of keys)
            fileKeys.set(`${key.kind}:${key.value}`, row.rowNumber);
        }
      }
      const invalid = issues.some((issue) => issue.severity === "error");
      summary[invalid ? "invalid" : "valid"] += 1;
      if (issues.some((issue) => issue.severity === "warning"))
        summary.warnings += 1;
      if (duplicate) {
        summary.duplicates += 1;
        if (!invalid)
          summary[
            duplicate.kind === "file" || duplicateStrategy === "skip"
              ? "toSkip"
              : "toUpdate"
          ] += 1;
      } else if (!invalid) summary.toCreate += 1;
      const storedDuplicate = duplicate
        ? {
            kind: duplicate.kind,
            existingRecordId: duplicate.existingRecordId || null,
            rowNumber: duplicate.rowNumber || null,
          }
        : null;
      operations.push({
        updateOne: {
          filter: { _id: row._id, tenant: tenantId, session: current._id },
          update: {
            $set: {
              normalized,
              issues,
              duplicate: storedDuplicate,
              status: invalid
                ? DATA_IMPORT_ROW_STATUS.INVALID
                : DATA_IMPORT_ROW_STATUS.VALID,
              resultRecord: null,
              resultMessage: null,
            },
          },
        },
      });
    }
    if (operations.length)
      await DataImportRowModel.bulkWrite(operations, { ordered: false });
    const validationRevision = createHash("sha256")
      .update(
        JSON.stringify({
          fileHash: session.fileHash,
          mapping,
          duplicateStrategy,
          tenantCurrency,
          modules: [...enabledModules].sort(),
        }),
      )
      .digest("hex");
    const updated = await DataImportSessionModel.findOneAndUpdate(
      {
        _id: current._id,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.VALIDATED,
          mapping,
          duplicateStrategy,
          validationRevision,
          summary,
        },
      },
      { returnDocument: "after" },
    ).lean();
    if (!updated)
      conflict({
        message: "Import validation state changed unexpectedly.",
        code: "IMPORT_STATE_CONFLICT",
      });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "validated",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.PRODUCTS,
        duplicateStrategy,
        valid: summary.valid,
        invalid: summary.invalid,
        duplicates: summary.duplicates,
      },
    });
    return serializeImportSession(updated);
  } catch (error) {
    await DataImportSessionModel.updateOne(
      {
        _id: current._id,
        tenant: tenantId,
        status: DATA_IMPORT_STATUS.VALIDATING,
      },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          lastError: {
            code: "IMPORT_VALIDATION_FAILED",
            message: (error instanceof Error
              ? error.message
              : "Product import validation failed."
            ).slice(0, 1_000),
          },
        },
      },
    );
    throw error;
  }
};
