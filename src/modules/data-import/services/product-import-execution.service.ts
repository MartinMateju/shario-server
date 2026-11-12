import { randomUUID } from "node:crypto";

import mongoose from "mongoose";

import ProductModel from "@/modules/product/product.model.js";
import { isOpenStudioLocationDuplicateError } from "@/modules/product/open-studio-location-index.js";
import { OPEN_STUDIO_ALREADY_EXISTS_MESSAGE } from "@/modules/product/open-studio-location.policy.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROW_STATUS,
  DATA_IMPORT_STATUS,
} from "../data-import.constants.js";
import DataImportRowModel from "../data-import-row.model.js";
import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportSessionModel from "../data-import-session.model.js";
import type { NormalizedProductImportRow } from "../data-import.types.js";
import { recordDataImportAudit } from "./data-import-audit.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { completeImportWithRollbackAvailability } from "./data-import-rollback-availability.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";

const PRODUCT_CREATE_FIELDS = [
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
  "importMetadata",
] as const;

const LEASE_MS = 5 * 60_000;

const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : "Product import failed.").slice(
    0,
    1_000,
  );

const existingProductKind = (product: any): string => {
  if (product?.kind) return String(product.kind);
  if (
    ["workshop", "public-workshop", "private-workshop"].includes(product?.type)
  )
    return "open-studio";
  if (["course", "public-course", "private-course"].includes(product?.type))
    return "class";
  if (["blocker", "private-studio"].includes(product?.type))
    return "private-studio";
  return "";
};

const findCurrentProduct = async (
  tenantId: string,
  normalized: NormalizedProductImportRow,
  transaction: mongoose.ClientSession | null = null,
) => {
  const exactInsensitive = (value: string) => ({
    $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    $options: "i",
  });
  const conditions: Record<string, unknown>[] = [];
  if (normalized.externalId)
    conditions.push({ "importMetadata.externalId": normalized.externalId });
  if (normalized.sku)
    conditions.push({ sku: exactInsensitive(normalized.sku) });
  if (normalized.name)
    conditions.push({ name: exactInsensitive(normalized.name) });
  const direct = conditions.length
    ? await ProductModel.find({ tenant: tenantId, $or: conditions })
        .select("+importMetadata")
        .session(transaction)
        .lean()
    : [];
  const byId = new Map(
    (direct as any[]).map((item) => [String(item._id), item]),
  );
  return byId.size > 1
    ? { record: null, conflict: true }
    : { record: [...byId.values()][0] || null, conflict: false };
};

const loadExecutionGuard = async (tenantId: string, actorId: string) => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection is unavailable.");
  const [access, tenant] = await Promise.all([
    resolveWorkspaceAccessForUser({ tenantId, userId: actorId }),
    db
      .collection("tenants")
      .findOne(
        { _id: new mongoose.Types.ObjectId(tenantId) },
        { projection: { modules: 1, "settings.currency": 1 } },
      ),
  ]);
  if (
    !access ||
    access.status !== "active" ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.PRODUCTS_IMPORT)
  ) {
    throw new Error(
      "The queued actor no longer has product import permission.",
    );
  }
  if (!tenant) throw new Error("The workspace is no longer available.");
  return {
    modules: (tenant.modules || {}) as Record<string, unknown>,
    currency: String((tenant.settings as any)?.currency || "CZK").toUpperCase(),
  };
};

const moduleEnabled = (
  modules: Record<string, unknown>,
  kind: string,
): boolean => {
  const moduleName = kind === "class" ? "courses" : "bookings";
  return Boolean(modules[moduleName]);
};

const importedProductPayload = ({
  tenantId,
  actorId,
  sessionId,
  rowNumber,
  fileType,
  normalized,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  rowNumber: number;
  fileType: "csv" | "xlsx";
  normalized: NormalizedProductImportRow;
}) => ({
  tenant: tenantId,
  createdBy: actorId,
  name: normalized.name,
  description: normalized.description,
  sku: normalized.sku,
  type: normalized.type,
  kind: normalized.kind,
  kindContractVersion: 2 as const,
  bookingMode:
    normalized.kind === "open-studio" ? normalized.bookingMode : null,
  price: normalized.price ?? 0,
  extraCharge: normalized.extraCharge ?? 0,
  maxNumberOfParticipants: normalized.capacity,
  currency: normalized.currency,
  label: "",
  imageSrc: "",
  voucherTemplate: "",
  couponProduct: null,
  isActive: normalized.isActive ?? true,
  sortOrder: normalized.sortOrder ?? 0,
  importMetadata: {
    source: fileType,
    importId: sessionId,
    importKey: `${sessionId}:${rowNumber}`,
    ...(normalized.externalId ? { externalId: normalized.externalId } : {}),
    importedAt: new Date(),
    importedBy: actorId,
  },
});

const updateImportedProduct = async ({
  tenantId,
  actorId,
  sessionId,
  fileType,
  product,
  normalized,
  rowNumber,
  transaction,
}: {
  tenantId: string;
  actorId: string;
  sessionId: string;
  fileType: "csv" | "xlsx";
  product: any;
  normalized: NormalizedProductImportRow;
  rowNumber: number;
  transaction: mongoose.ClientSession;
}) => {
  if (existingProductKind(product) !== normalized.kind)
    throw new Error("An import cannot change an existing product kind.");
  const provided = new Set(normalized.providedFields);
  const set: Record<string, unknown> = {
    "importMetadata.source": fileType,
    "importMetadata.importId": sessionId,
    "importMetadata.importedAt": new Date(),
    "importMetadata.importedBy": actorId,
  };
  if (!product.importMetadata?.importKey) {
    set["importMetadata.importKey"] = `${sessionId}:${rowNumber}`;
  }
  const directFields: Array<[string, keyof NormalizedProductImportRow]> = [
    ["name", "name"],
    ["description", "description"],
    ["sku", "sku"],
    ["price", "price"],
    ["extraCharge", "extraCharge"],
    ["currency", "currency"],
    ["maxNumberOfParticipants", "capacity"],
    ["bookingMode", "bookingMode"],
    ["isActive", "isActive"],
    ["sortOrder", "sortOrder"],
  ];
  for (const [target, source] of directFields) {
    if (provided.has(source as never)) set[target] = normalized[source];
  }
  if (normalized.externalId)
    set["importMetadata.externalId"] = normalized.externalId;
  const updated = await ProductModel.findOneAndUpdate(
    { _id: product._id, tenant: tenantId, updatedAt: product.updatedAt },
    { $set: set },
    { returnDocument: "after", runValidators: true, session: transaction },
  ).select("+importMetadata");
  if (!updated) throw new Error("Product changed during import execution.");
  return { record: updated, affectedFields: Object.keys(set) };
};

const markRow = (
  rowId: any,
  status: string,
  resultRecord: any,
  resultMessage: string,
) =>
  DataImportRowModel.updateOne(
    { _id: rowId },
    { $set: { status, resultRecord, resultMessage } },
  );

export const processProductImportSession = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const claimToken = randomUUID();
  const now = new Date();
  const session = await DataImportSessionModel.findOneAndUpdate(
    {
      _id: sessionId,
      tenant: tenantId,
      entityType: DATA_IMPORT_ENTITY.PRODUCTS,
      $or: [
        { status: DATA_IMPORT_STATUS.QUEUED },
        { status: DATA_IMPORT_STATUS.FAILED },
        {
          status: DATA_IMPORT_STATUS.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: DATA_IMPORT_STATUS.PROCESSING,
        startedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        claimToken,
        lastError: null,
      },
    },
    { returnDocument: "after" },
  )
    .select("+claimToken")
    .lean();
  if (!session) return { skipped: true, reason: "not_claimable" };
  const actorId = String(session.queuedBy || session.createdBy);
  try {
    const rows = await DataImportRowModel.find({
      tenant: tenantId,
      session: session._id,
      status: {
        $in: [DATA_IMPORT_ROW_STATUS.VALID, DATA_IMPORT_ROW_STATUS.PROCESSING],
      },
    }).sort({ rowNumber: 1 });
    let heartbeatAt = 0;
    let executionGuard: Awaited<ReturnType<typeof loadExecutionGuard>> | null =
      null;
    for (let index = 0; index < rows.length; index += 1) {
      if (Date.now() - heartbeatAt >= 30_000) {
        executionGuard = await loadExecutionGuard(tenantId, actorId);
        const heartbeat = await DataImportSessionModel.updateOne(
          { _id: session._id, tenant: tenantId, claimToken },
          { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
        );
        if (!heartbeat.matchedCount)
          throw new Error("Product import execution lease was lost.");
        heartbeatAt = Date.now();
      }
      const row = await DataImportRowModel.findOneAndUpdate(
        {
          _id: rows[index]._id,
          tenant: tenantId,
          session: session._id,
          status: {
            $in: [
              DATA_IMPORT_ROW_STATUS.VALID,
              DATA_IMPORT_ROW_STATUS.PROCESSING,
            ],
          },
        },
        { $set: { status: DATA_IMPORT_ROW_STATUS.PROCESSING } },
        { returnDocument: "after" },
      );
      if (!row) continue;
      try {
        const committed = await DataImportMutationModel.findOne({
          tenant: tenantId,
          session: session._id,
          row: row._id,
          isCanonicalResult: true,
        }).lean();
        if (committed) {
          await markRow(
            row._id,
            committed.importOutcome === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            committed.target,
            committed.importMessage,
          );
          continue;
        }
        const normalized =
          row.normalized as unknown as NormalizedProductImportRow;
        if (row.duplicate?.kind === "file") {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            null,
            "Duplicate row in the uploaded file.",
          );
          continue;
        }
        if (
          !executionGuard ||
          !moduleEnabled(executionGuard.modules, normalized.kind)
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "The required workspace module is no longer enabled.",
          );
          continue;
        }
        const match = await findCurrentProduct(tenantId, normalized);
        assertImportRecordNotRolledBack(match.record);
        if (match.record?.isArchived) throw new Error("Archived studio products cannot be updated by an import.");
        if (match.conflict) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "Product identifiers now match multiple records.",
          );
          continue;
        }
        if (
          match.record &&
          existingProductKind(match.record) !== normalized.kind
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            "An import cannot change an existing product kind.",
          );
          continue;
        }
        if (
          match.record &&
          session.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
        ) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.SKIPPED,
            match.record._id,
            "Existing product skipped.",
          );
          continue;
        }
        if (normalized.currency !== executionGuard.currency) {
          await markRow(
            row._id,
            DATA_IMPORT_ROW_STATUS.FAILED,
            null,
            `Product currency must match the current workspace currency (${executionGuard.currency}).`,
          );
          continue;
        }
        const transaction = await mongoose.startSession();
        try {
          let outcome: {
            action: "created" | "updated";
            recordId: unknown;
            message: string;
          } | null = null;
          await transaction.withTransaction(async () => {
            const currentMatch = await findCurrentProduct(
              tenantId,
              normalized,
              transaction,
            );
            if (currentMatch.conflict)
              throw new Error("Product identity changed during execution.");
            assertImportRecordNotRolledBack(currentMatch.record);
            if (currentMatch.record?.isArchived) throw new Error("Archived studio products cannot be updated by an import.");
            if (match.record) {
              if (
                !currentMatch.record ||
                String(currentMatch.record._id) !== String(match.record._id)
              )
                throw new Error("Product identity changed during execution.");
              const updated = await updateImportedProduct({
                tenantId,
                actorId,
                sessionId,
                rowNumber: row.rowNumber,
                fileType: session.fileType,
                product: currentMatch.record,
                normalized,
                transaction,
              });
              await recordDataImportMutation({
                tenantId,
                sessionId,
                rowId: row._id,
                rowNumber: row.rowNumber,
                entityType: DATA_IMPORT_ENTITY.PRODUCTS,
                mutationKey: `${sessionId}:${row.rowNumber}`,
                operation: importMutationOperation.UPDATE,
                importOutcome: "updated",
                importMessage: "Existing product updated.",
                targetId: updated.record._id,
                affectedFields: updated.affectedFields,
                beforeRecord: currentMatch.record,
                afterRecord: updated.record,
                actorId,
                transaction,
              });
              outcome = {
                action: "updated",
                recordId: updated.record._id,
                message: "Existing product updated.",
              };
              return;
            }
            if (currentMatch.record)
              throw new Error(
                "A matching product was created after validation. Validate again.",
              );
            const importKey = `${sessionId}:${row.rowNumber}`;
            const created = await ProductModel.create(
              [
                importedProductPayload({
                  tenantId,
                  actorId,
                  sessionId,
                  rowNumber: row.rowNumber,
                  fileType: session.fileType,
                  normalized,
                }) as any,
              ],
              { session: transaction },
            );
            await recordDataImportMutation({
              tenantId,
              sessionId,
              rowId: row._id,
              rowNumber: row.rowNumber,
              entityType: DATA_IMPORT_ENTITY.PRODUCTS,
              mutationKey: importKey,
              operation: importMutationOperation.CREATE,
              importOutcome: "created",
              importMessage: "Product created.",
              targetId: created[0]._id,
              affectedFields: PRODUCT_CREATE_FIELDS,
              beforeRecord: null,
              afterRecord: created[0],
              actorId,
              transaction,
            });
            outcome = {
              action: "created",
              recordId: created[0]._id,
              message: "Product created.",
            };
          });
          if (!outcome) throw new Error("Product import transaction failed.");
          await markRow(
            row._id,
            outcome.action === "created"
              ? DATA_IMPORT_ROW_STATUS.CREATED
              : DATA_IMPORT_ROW_STATUS.UPDATED,
            outcome.recordId,
            outcome.message,
          );
        } finally {
          await transaction.endSession();
        }
      } catch (error: any) {
        if (isOpenStudioLocationDuplicateError(error)) {
          await markRow(row._id, DATA_IMPORT_ROW_STATUS.FAILED, null, OPEN_STUDIO_ALREADY_EXISTS_MESSAGE);
          continue;
        }
        if (error?.code === 11000) {
          const normalized =
            row.normalized as unknown as NormalizedProductImportRow;
          const race = await findCurrentProduct(tenantId, normalized);
          assertImportRecordNotRolledBack(race.record);
          if (race.record) {
            await markRow(
              row._id,
              DATA_IMPORT_ROW_STATUS.SKIPPED,
              race.record._id,
              "A concurrent import already created this product.",
            );
            continue;
          }
        }
        await markRow(
          row._id,
          DATA_IMPORT_ROW_STATUS.FAILED,
          null,
          safeError(error),
        );
      }
    }
    const [created, updated, skipped, failed] = await Promise.all([
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.CREATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.UPDATED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.SKIPPED,
      }),
      DataImportRowModel.countDocuments({
        tenant: tenantId,
        session: session._id,
        status: DATA_IMPORT_ROW_STATUS.FAILED,
      }),
    ]);
    await completeImportWithRollbackAvailability({
      tenantId,
      sessionId,
      claimToken,
      summary: { created, updated, skipped, failed },
    });
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "completed",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.PRODUCTS,
        created,
        updated,
        skipped,
        failed,
      },
    });
    return { created, updated, skipped, failed };
  } catch (error) {
    await DataImportSessionModel.updateOne(
      { _id: session._id, tenant: tenantId, claimToken },
      {
        $set: {
          status: DATA_IMPORT_STATUS.FAILED,
          leaseExpiresAt: null,
          claimToken: null,
          lastError: {
            code: "IMPORT_EXECUTION_FAILED",
            message: safeError(error),
          },
        },
      },
    );
    await recordDataImportAudit({
      tenantId,
      sessionId,
      actorId,
      action: "failed",
      metadata: {
        entityType: DATA_IMPORT_ENTITY.PRODUCTS,
        code: "IMPORT_EXECUTION_FAILED",
      },
    });
    throw error;
  }
};
