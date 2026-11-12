import { assertVoucherCanBeIssued, normalizeVoucherSettings } from "@/modules/coupon/voucher-policy.js";
import { voucherDesignSchema } from "@/modules/coupon/voucher-design.js";
import { acquireVoucherTenantMutationLock, assertVoucherOfferingPublicationAllowed } from "@/modules/product/voucher-offering.policy.js";
import mongoose from "mongoose";

import ProductModel from "@/modules/product/product.model.js";
import {
  normalizeProductKindV2,
  resolveLegacyProductTypeV2,
} from "@/modules/product/product-kind-v2.contract.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
} from "../data-import.constants.js";
import type { NormalizedVoucherProductImportRow } from "../data-import.types.js";
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

const VOUCHER_PRODUCT_CREATE_FIELDS = [
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
  "importMetadata",
] as const;

const exactInsensitive = (value: string) => ({
  $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  $options: "i",
});
const productKind = (record: any): string => {
  const direct = normalizeProductKindV2(record?.kind);
  if (direct) return direct;
  const legacy = resolveLegacyProductTypeV2(record?.type);
  return legacy.status === "mapped" ? legacy.kind : "";
};

const findVoucherProduct = async ({
  tenantId,
  normalized,
  existingRecordId,
  importKey,
  session = null,
}: {
  tenantId: string;
  normalized: NormalizedVoucherProductImportRow;
  existingRecordId?: unknown;
  importKey: string;
  session?: mongoose.ClientSession | null;
}) => {
  const or: Record<string, unknown>[] = [
    { "importMetadata.importKey": importKey },
    { "importMetadata.fingerprint": normalized.fingerprint },
  ];
  if (existingRecordId) or.push({ _id: existingRecordId });
  if (normalized.externalId)
    or.push({ "importMetadata.externalId": normalized.externalId });
  if (normalized.sku) or.push({ sku: exactInsensitive(normalized.sku) });
  if (normalized.name) or.push({ name: exactInsensitive(normalized.name) });
  const rows = await ProductModel.find({ tenant: tenantId, $or: or })
    .select("+stripeProductId +stripePriceId +importMetadata")
    .session(session)
    .lean();
  const unique = new Map(
    rows.map((record: any) => [String(record._id), record]),
  );
  if (unique.size > 1)
    throw new Error("Voucher product identity is ambiguous.");
  return [...unique.values()][0] || null;
};

const executeVoucherProductRow = async ({
  tenantId,
  sessionId,
  actorId,
  session: importSession,
  row,
}: any) => {
  const normalized = row.normalized as NormalizedVoucherProductImportRow;
  const guard = await loadCommerceImportGuard({
    tenantId,
    actorId,
    permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
    moduleName: "vouchers",
  });
  if (guard.currency !== normalized.currency)
    throw new Error("Workspace currency changed after validation.");
  const importKey = `${sessionId}:${row.rowNumber}`;
  let record = await findVoucherProduct({
    tenantId,
    normalized,
    existingRecordId: row.duplicate?.existingRecordId,
    importKey,
  });
  if (record?.importMetadata?.lastMutationKey === importKey)
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Voucher product row was already applied.",
    };
  if (
    record?.importMetadata?.externalId &&
    normalized.externalId &&
    record.importMetadata.externalId !== normalized.externalId
  )
    throw new Error(
      "Voucher product external identity changed after validation.",
    );
  if (record && productKind(record) !== "voucher")
    throw new Error("The matched product is not a Voucher product.");
  if (
    record &&
    importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
  )
    return {
      action: "skipped" as const,
      recordId: record._id,
      message: "Existing voucher product skipped.",
    };
  if (record && !record.importMetadata)
    throw new Error("Only import-owned voucher products can be updated.");

  const transaction = await mongoose.startSession();
  try {
    let result: any;
    await transaction.withTransaction(async () => {
      const lockedTenant = await acquireVoucherTenantMutationLock(String(tenantId), transaction);
      const currentGuard = await loadCommerceImportGuard({
        tenantId,
        actorId,
        permission: WORKSPACE_PERMISSION.VOUCHERS_IMPORT,
        moduleName: "vouchers",
        session: transaction,
      });
      if (currentGuard.currency !== normalized.currency)
        throw new Error("Workspace currency changed after validation.");
      const current = await findVoucherProduct({
        tenantId,
        normalized,
        existingRecordId: record?._id || row.duplicate?.existingRecordId,
        importKey,
        session: transaction,
      });
      assertImportRecordNotRolledBack(current);
      if (current?.importMetadata?.lastMutationKey === importKey) {
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Voucher product row was already applied.",
        };
        return;
      }
      if (!record && current)
        throw new Error(
          "A matching voucher product was created after validation. Validate again.",
        );
      if (record && (!current || String(current._id) !== String(record._id)))
        throw new Error("Voucher product identity changed after validation.");
      if (
        current &&
        new Date(current.updatedAt).toISOString() !==
          normalized.expectedUpdatedAt
      )
        throw new Error(
          "Voucher product changed after validation. Validate again.",
        );
      if (
        current &&
        (productKind(current) !== "voucher" || !current.importMetadata)
      )
        throw new Error(
          "Voucher product update protection changed after validation.",
        );
      if (
        current?.importMetadata?.externalId &&
        normalized.externalId &&
        current.importMetadata.externalId !== normalized.externalId
      )
        throw new Error(
          "Voucher product external identity changed after validation.",
        );
      if (
        current &&
        importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
      ) {
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Existing voucher product skipped.",
        };
        return;
      }
      const provided = new Set(normalized.providedFields);
      const desiredIsActive = provided.has("isActive") ? normalized.isActive : current?.isActive ?? false;
      if (
        desiredIsActive &&
        !String(current?.voucherTemplate || "").trim() &&
        !voucherDesignSchema.safeParse(current?.voucherDesign).success
      )
        throw new Error(
          "Configure a voucher design or PDF template before activating this voucher product.",
        );
      if (desiredIsActive) assertVoucherCanBeIssued(normalizeVoucherSettings(current?.voucherSettings), new Date(), lockedTenant.settings?.timezone ?? "UTC");
      await assertVoucherOfferingPublicationAllowed({ tenantId: String(tenantId), session: transaction, tenant: lockedTenant, current, desired: { kind: "voucher", isActive: desiredIsActive } });
      if (
        current &&
        (current.stripeProductId || current.stripePriceId) &&
        ((provided.has("value") &&
          Number(current.price) !== Number(normalized.value)) ||
          (provided.has("currency") &&
            String(current.currency) !== normalized.currency))
      )
        throw new Error(
          "Stripe-linked voucher value or currency cannot be changed.",
        );
      if (!current) {
        if (normalized.isActive)
          throw new Error(
            "New voucher products must remain inactive until a voucher design or PDF template is configured.",
          );
        const created = await ProductModel.create(
          [
            {
              tenant: importObjectId(tenantId),
              createdBy: importObjectId(actorId),
              name: normalized.name,
              description: normalized.description,
              sku: normalized.sku,
              type: "coupon",
              kind: "voucher",
              kindContractVersion: 2,
              bookingMode: null,
              price: normalized.value,
              extraCharge: 0,
              maxNumberOfParticipants: null,
              currency: normalized.currency,
              imageSrc: "",
              label: normalized.name,
              voucherTemplate: "",
              voucherSettings: { version: 1, type: "value", validity: { mode: "months", months: 12 } },
              couponProduct: null,
              isActive: false,
              sortOrder: normalized.sortOrder ?? 0,
              importMetadata: importMetadata({
                sessionId,
                rowNumber: row.rowNumber,
                actorId,
                fileType: importSession.fileType,
                externalId: normalized.externalId,
                fingerprint: String(normalized.fingerprint),
              }),
            },
          ] as any,
          { session: transaction },
        );
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
          mutationKey: importKey,
          operation: importMutationOperation.CREATE,
          importOutcome: "created",
          importMessage: "Voucher product imported inactive.",
          targetId: created[0]._id,
          affectedFields: VOUCHER_PRODUCT_CREATE_FIELDS,
          beforeRecord: null,
          afterRecord: created[0],
          actorId,
          transaction,
        });
        result = {
          action: "created" as const,
          recordId: created[0]._id,
          message: "Voucher product imported inactive.",
        };
        return;
      }
      const set: Record<string, unknown> = {
        // Import-owned legacy coupon products are upgraded on their next
        // mutation so every write leaves the Product V2 discriminator and its
        // compatibility projection in agreement.
        type: "coupon",
        kind: "voucher",
        kindContractVersion: 2,
        bookingMode: null,
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
      for (const [target, source] of [
        ["name", "name"],
        ["description", "description"],
        ["sku", "sku"],
        ["price", "value"],
        ["currency", "currency"],
        ["isActive", "isActive"],
        ["sortOrder", "sortOrder"],
      ] as const)
        if (provided.has(source)) set[target] = normalized[source];
      if (provided.has("name")) set.label = normalized.name;
      const updated = await ProductModel.findOneAndUpdate(
        { _id: current._id, tenant: tenantId, updatedAt: current.updatedAt },
        { $set: set },
        { returnDocument: "after", runValidators: true, session: transaction },
      ).select("+importMetadata");
      if (!updated)
        throw new Error("Voucher product changed during execution.");
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
        mutationKey: importKey,
        operation: importMutationOperation.UPDATE,
        importOutcome: "updated",
        importMessage: "Voucher product updated.",
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
        message: "Voucher product updated.",
      };
    });
    return result;
  } catch (error) {
    if (isImportDuplicateKey(error)) {
      record = await ProductModel.findOne({
        tenant: tenantId,
        "importMetadata.lastMutationKey": importKey,
      })
        .select("+importMetadata")
        .lean();
      if (
        record &&
        productKind(record) === "voucher" &&
        String(record.importMetadata?.fingerprint) === normalized.fingerprint
      )
        return {
          action: "skipped" as const,
          recordId: record._id,
          message: "Voucher product row was already applied.",
        };
    }
    throw error;
  } finally {
    await transaction.endSession();
  }
};

export const processVoucherProductImportSession = ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) =>
  processStagedImportSession({
    tenantId,
    sessionId,
    entityType: DATA_IMPORT_ENTITY.VOUCHER_PRODUCTS,
    executeRow: executeVoucherProductRow,
  });
