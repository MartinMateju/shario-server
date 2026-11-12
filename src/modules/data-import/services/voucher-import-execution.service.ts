import mongoose from "mongoose";

import { Coupon } from "@/modules/coupon/coupon.model.js";
import { acquireVoucherTenantMutationLock } from "@/modules/product/voucher-offering.policy.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import ProductModel from "@/modules/product/product.model.js";
import {
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
} from "@/modules/product/product-kind-v2.contract.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import UserModel from "@/modules/user/user.model.js";

import { validateVoucherImportRow } from "../adapters/voucher-import.adapter.js";
import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
} from "../data-import.constants.js";
import type { NormalizedVoucherImportRow } from "../data-import.types.js";
import {
  importMetadata,
  importObjectId,
  isImportDuplicateKey,
  loadCommerceImportGuard,
} from "./commerce-import-execution.utils.js";
import { processStagedImportSession } from "./staged-import-execution.service.js";
import {
  importMutationOperation,
  recordDataImportMutation,
} from "./data-import-mutation.service.js";
import { assertImportRecordNotRolledBack } from "./data-import-rollback-marker.service.js";

const VOUCHER_CREATE_FIELDS = [
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
] as const;

const productKind = (record: any): string => {
  const direct = normalizeProductKindV2(record?.kind);
  if (direct) return direct;
  const legacy = resolveLegacyProductTypeV2(record?.type);
  return legacy.status === "mapped" ? legacy.kind : "";
};
const storedStatus = (coupon: any, now = new Date()): string =>
  coupon.redeemedAt
    ? "redeemed"
    : coupon.expiresAt && new Date(coupon.expiresAt) <= now
      ? "expired"
      : coupon.isActive
        ? "active"
        : "disabled";
const transitionAllowed = (from: string, to: string): boolean =>
  from === to || from === "active";

const findVoucher = async ({
  tenantId,
  normalized,
  existingRecordId,
  importKey,
  session = null,
}: {
  tenantId: string;
  normalized: NormalizedVoucherImportRow;
  existingRecordId?: unknown;
  importKey: string;
  session?: mongoose.ClientSession | null;
}) => {
  const or: Record<string, unknown>[] = [
    { "importMetadata.importKey": importKey },
    { "importMetadata.fingerprint": normalized.fingerprint },
    { promoCode: normalized.promoCode },
  ];
  if (existingRecordId) or.push({ _id: existingRecordId });
  if (normalized.externalId)
    or.push({ "importMetadata.externalId": normalized.externalId });
  const rows = await Coupon.find({ tenant: tenantId, $or: or })
    .select("+importMetadata")
    .session(session)
    .lean();
  const unique = new Map(
    rows.map((record: any) => [String(record._id), record]),
  );
  if (unique.size > 1) throw new Error("Voucher identity is ambiguous.");
  return [...unique.values()][0] || null;
};

const assertVoucherIdentity = (
  record: any,
  normalized: NormalizedVoucherImportRow,
): void => {
  const completeSnapshot =
    Number.isSafeInteger(Number(record.valueMinorSnapshot)) &&
    Number(record.valueMinorSnapshot) > 0 &&
    Boolean(record.currencySnapshot);
  if (!completeSnapshot)
    throw new Error(
      "Run the voucher value snapshot backfill before updating this legacy voucher.",
    );
  if (
    String(record.product) !== normalized.productId ||
    String(record.promoCode) !== normalized.promoCode ||
    Number(record.valueMinorSnapshot) !== Number(normalized.valueMinor) ||
    String(record.currencySnapshot) !== normalized.currency ||
    (record.importMetadata?.externalId &&
      normalized.externalId &&
      record.importMetadata.externalId !== normalized.externalId)
  )
    throw new Error("Voucher immutable identity changed after validation.");
};

const executeVoucherRow = async ({
  tenantId,
  sessionId,
  actorId,
  session: importSession,
  row,
}: any) => {
  const normalized = row.normalized as NormalizedVoucherImportRow;
  const guard = await loadCommerceImportGuard({
    tenantId,
    actorId,
    permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
    moduleName: "vouchers",
  });
  if (guard.currency !== normalized.currency)
    throw new Error("Workspace currency changed after validation.");
  const importKey = `${sessionId}:${row.rowNumber}`;
  let record = await findVoucher({
    tenantId,
    normalized,
    existingRecordId: row.duplicate?.existingRecordId,
    importKey,
  });
  if (record?.importMetadata?.lastMutationKey === importKey)
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Voucher row was already applied.",
    };
  if (record) assertVoucherIdentity(record, normalized);
  if (
    record &&
    importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
  )
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Existing voucher skipped.",
    };

  const transaction = await mongoose.startSession();
  try {
    let result: any;
    await transaction.withTransaction(async () => {
      await acquireVoucherTenantMutationLock(tenantId, transaction);
      const currentGuard = await loadCommerceImportGuard({
        tenantId,
        actorId,
        permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
        moduleName: "vouchers",
        session: transaction,
      });
      if (currentGuard.currency !== normalized.currency)
        throw new Error("Workspace currency changed after validation.");
      const product = await ProductModel.findOne({
        _id: normalized.productId,
        tenant: tenantId,
      })
        .select("_id kind type")
        .session(transaction)
        .lean();
      if (!product || productKind(product) !== "voucher")
        throw new Error(
          "The tenant-scoped Voucher product is no longer available.",
        );
      if (normalized.customerId) {
        const customer = await UserModel.exists({
          _id: normalized.customerId,
          tenant: tenantId,
        }).session(transaction);
        if (!customer)
          throw new Error(
            "The tenant-scoped redeemed customer is no longer available.",
          );
      }
      const runtimeIssues = validateVoucherImportRow(normalized, new Date());
      if (runtimeIssues.some((issue) => issue.severity === "error"))
        throw new Error(runtimeIssues[0].message);
      const current = await findVoucher({
        tenantId,
        normalized,
        existingRecordId: record?._id || row.duplicate?.existingRecordId,
        importKey,
        session: transaction,
      });
      assertImportRecordNotRolledBack(current);
      if (current?.importMetadata?.lastMutationKey === importKey) {
        assertVoucherIdentity(current, normalized);
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Voucher row was already applied.",
        };
        return;
      }
      if (!record && current)
        throw new Error(
          "A matching voucher was created after validation. Validate again.",
        );
      if (record && (!current || String(current._id) !== String(record._id)))
        throw new Error("Voucher identity changed after validation.");
      if (current) {
        assertVoucherIdentity(current, normalized);
        if (
          new Date(current.updatedAt).toISOString() !==
          normalized.expectedUpdatedAt
        )
          throw new Error("Voucher changed after validation. Validate again.");
        if (!current.importMetadata)
          throw new Error("Only import-owned vouchers can be updated.");
        if (!transitionAllowed(storedStatus(current), normalized.status))
          throw new Error(
            "Voucher imports cannot resurrect a terminal voucher.",
          );
        if (
          current.reservedAt ||
          current.reservedBy ||
          current.reservedOrder ||
          current.reservedUntil ||
          current.order
        )
          throw new Error("Reserved or ordered vouchers cannot be updated.");
        const relatedCredit = await MoneyCredit.exists({
          tenant: tenantId,
          transactions: { $elemMatch: { relatedCoupon: current._id } },
        }).session(transaction);
        if (relatedCredit)
          throw new Error(
            "A voucher linked to a credit transaction cannot be updated.",
          );
      }
      if (
        current &&
        importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
      ) {
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Existing voucher skipped.",
        };
        return;
      }
      if (!current) {
        const created = await Coupon.create(
          [
            {
              tenant: importObjectId(tenantId),
              product: importObjectId(normalized.productId),
              promoCode: normalized.promoCode,
              valueMinorSnapshot: normalized.valueMinor,
              currencySnapshot: normalized.currency,
              isActive: normalized.status === "active",
              singleUse: true,
              expiresAt: normalized.expiresAt
                ? new Date(normalized.expiresAt)
                : null,
              reservedAt: null,
              reservedBy: null,
              reservedOrder: null,
              reservedUntil: null,
              redeemedAt:
                normalized.status === "redeemed"
                  ? new Date(normalized.redeemedAt)
                  : null,
              redeemedBy:
                normalized.status === "redeemed" && normalized.customerId
                  ? importObjectId(normalized.customerId)
                  : null,
              order: null,
              createdBy: importObjectId(actorId),
              importMetadata: {
                ...importMetadata({
                  sessionId,
                  rowNumber: row.rowNumber,
                  actorId,
                  fileType: importSession.fileType,
                  externalId: normalized.externalId,
                  fingerprint: String(normalized.fingerprint),
                }),
                note: normalized.note,
              },
            },
          ] as any,
          { session: transaction },
        );
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.VOUCHERS,
          mutationKey: importKey,
          operation: importMutationOperation.CREATE,
          importOutcome: "created",
          importMessage: "Voucher liability imported.",
          targetId: created[0]._id,
          affectedFields: VOUCHER_CREATE_FIELDS,
          beforeRecord: null,
          afterRecord: created[0],
          actorId,
          transaction,
        });
        result = {
          action: "created" as const,
          recordId: created[0]._id,
          message: "Voucher liability imported.",
        };
        return;
      }
      const provided = new Set(normalized.providedFields);
      const set: Record<string, unknown> = {
        "importMetadata.source": importSession.fileType,
        "importMetadata.importId": sessionId,
        "importMetadata.fingerprint": normalized.fingerprint,
        "importMetadata.lastMutationKey": importKey,
        "importMetadata.importedAt": new Date(),
        "importMetadata.importedBy": importObjectId(actorId),
      };
      if (!current.importMetadata.importKey)
        set["importMetadata.importKey"] = importKey;
      if (normalized.externalId)
        set["importMetadata.externalId"] = normalized.externalId;
      if (provided.has("status")) set.isActive = normalized.status === "active";
      if (provided.has("expiresAt"))
        set.expiresAt = normalized.expiresAt
          ? new Date(normalized.expiresAt)
          : null;
      if (provided.has("redeemedAt"))
        set.redeemedAt = normalized.redeemedAt
          ? new Date(normalized.redeemedAt)
          : null;
      if (
        provided.has("customerExternalId") ||
        provided.has("customerEmail") ||
        provided.has("customerPhone")
      )
        set.redeemedBy = normalized.customerId
          ? importObjectId(normalized.customerId)
          : null;
      if (provided.has("note")) set["importMetadata.note"] = normalized.note;
      const updated = await Coupon.findOneAndUpdate(
        { _id: current._id, tenant: tenantId, updatedAt: current.updatedAt },
        { $set: set },
        { returnDocument: "after", runValidators: true, session: transaction },
      ).select("+importMetadata");
      if (!updated) throw new Error("Voucher changed during execution.");
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.VOUCHERS,
        mutationKey: importKey,
        operation: importMutationOperation.UPDATE,
        importOutcome: "updated",
        importMessage: "Voucher state updated without financial side effects.",
        targetId: updated._id,
        affectedFields: Object.keys(set),
        beforeRecord: current,
        afterRecord: updated,
        actorId,
        transaction,
      });
      result = {
        action: "updated" as const,
        recordId: updated._id,
        message: "Voucher state updated without financial side effects.",
      };
    });
    return result;
  } catch (error) {
    if (isImportDuplicateKey(error)) {
      record = await Coupon.findOne({
        tenant: tenantId,
        "importMetadata.lastMutationKey": importKey,
      })
        .select("+importMetadata")
        .lean();
      if (record) {
        assertVoucherIdentity(record, normalized);
        return {
          action: "skipped" as const,
          recordId: record._id,
          message: "Voucher row was already applied.",
        };
      }
    }
    throw error;
  } finally {
    await transaction.endSession();
  }
};

export const processVoucherImportSession = ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) =>
  processStagedImportSession({
    tenantId,
    sessionId,
    entityType: DATA_IMPORT_ENTITY.VOUCHERS,
    executeRow: executeVoucherRow,
  });
