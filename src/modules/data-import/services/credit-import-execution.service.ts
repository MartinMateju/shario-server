import mongoose from "mongoose";

import CreditImportAllocationModel from "@/modules/money-credit/credit-import-allocation.model.js";
import { MONEY_CREDIT_TRANSACTION_TYPE } from "@/modules/money-credit/money-credit.constants.js";
import { resolveCreditBalanceMinor } from "@/modules/money-credit/money-credit.balance.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import UserModel from "@/modules/user/user.model.js";
import {
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
} from "../data-import.constants.js";
import type { NormalizedCreditImportRow } from "../data-import.types.js";
import {
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

const CREDIT_ALLOCATION_FIELDS = [
  "targetAmountMinor",
  "currency",
  "revision",
  "note",
  "source",
  "importId",
  "lastMutationKey",
  "importedAt",
  "importedBy",
] as const;

const findAllocation = async ({
  tenantId,
  normalized,
  existingRecordId,
  importKey,
  session = null,
}: {
  tenantId: string;
  normalized: NormalizedCreditImportRow;
  existingRecordId?: unknown;
  importKey: string;
  session?: mongoose.ClientSession | null;
}) => {
  const or: Record<string, unknown>[] = [
    { importKey },
    { fingerprint: normalized.fingerprint },
  ];
  if (existingRecordId) or.push({ _id: existingRecordId });
  if (normalized.externalId) or.push({ externalId: normalized.externalId });
  const rows = await CreditImportAllocationModel.find({
    tenant: tenantId,
    $or: or,
  })
    .session(session)
    .lean();
  const unique = new Map(
    rows.map((record: any) => [String(record._id), record]),
  );
  if (unique.size > 1)
    throw new Error("Credit allocation identity is ambiguous.");
  return [...unique.values()][0] || null;
};

const executeCreditRow = async ({
  tenantId,
  sessionId,
  actorId,
  session: importSession,
  row,
}: any) => {
  const normalized = row.normalized as NormalizedCreditImportRow;
  const guard = await loadCommerceImportGuard({
    tenantId,
    actorId,
    permission: WORKSPACE_PERMISSION.CREDITS_IMPORT,
    moduleName: "credits",
  });
  if (guard.currency !== normalized.currency)
    throw new Error("Workspace currency changed after validation.");
  const importKey = `${sessionId}:${row.rowNumber}`;
  let allocation = await findAllocation({
    tenantId,
    normalized,
    existingRecordId: row.duplicate?.existingRecordId,
    importKey,
  });
  if (
    allocation &&
    (String(allocation.user) !== normalized.customerId ||
      String(allocation.currency) !== normalized.currency ||
      (normalized.externalId &&
        String(allocation.externalId || "") !== normalized.externalId) ||
      String(allocation.fingerprint || "") !==
        String(normalized.fingerprint || ""))
  )
    throw new Error("Credit allocation identity changed after validation.");
  if (
    allocation &&
    importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
  )
    return {
      action: "skipped" as const,
      recordId: allocation._id,
      message: "Existing credit allocation skipped.",
    };

  const transaction = await mongoose.startSession();
  try {
    let result: any;
    await transaction.withTransaction(async () => {
      const currentGuard = await loadCommerceImportGuard({
        tenantId,
        actorId,
        permission: WORKSPACE_PERMISSION.CREDITS_IMPORT,
        moduleName: "credits",
        session: transaction,
      });
      if (currentGuard.currency !== normalized.currency)
        throw new Error("Workspace currency changed after validation.");
      const customer = await UserModel.findOne({
        _id: normalized.customerId,
        tenant: tenantId,
      })
        .select("_id moneyCredits moneyCreditsMinor")
        .session(transaction)
        .lean();
      if (!customer)
        throw new Error(
          "The tenant-scoped credit customer is no longer available.",
        );
      const userBalanceMinor = resolveCreditBalanceMinor({
        moneyCreditsMinor: customer.moneyCreditsMinor,
        moneyCredits: customer.moneyCredits,
        currency: normalized.currency as StudioCommerceCurrency,
      });
      const ledger = await MoneyCredit.findOne({
        tenant: tenantId,
        user: normalized.customerId,
      })
        .session(transaction)
        .lean();
      if (ledger) {
        const ledgerCurrency = String(ledger.currency || "").toUpperCase();
        const ledgerBalanceMinor = resolveCreditBalanceMinor({
          moneyCreditsMinor: ledger.balanceMinor,
          moneyCredits: ledger.balance,
          currency: ledgerCurrency as StudioCommerceCurrency,
        });
        if (
          ledgerCurrency !== normalized.currency &&
          (userBalanceMinor !== 0 ||
            ledgerBalanceMinor !== 0 ||
            (ledger.transactions || []).length > 0)
        )
          throw new Error("The non-empty credit ledger uses another currency.");
        if (
          ledgerCurrency === normalized.currency &&
          ledgerBalanceMinor !== userBalanceMinor
        )
          throw new Error(
            "Customer and credit ledger balance mirrors disagree.",
          );
      }
      const current = await findAllocation({
        tenantId,
        normalized,
        existingRecordId: allocation?._id || row.duplicate?.existingRecordId,
        importKey,
        session: transaction,
      });
      assertImportRecordNotRolledBack(current);
      if (current?.lastMutationKey === importKey) {
        if (
          String(current.user) !== normalized.customerId ||
          String(current.currency) !== normalized.currency ||
          String(current.fingerprint) !== normalized.fingerprint ||
          Number(current.targetAmountMinor) !==
            Number(normalized.balanceMinor) ||
          (normalized.externalId &&
            String(current.externalId || "") !== normalized.externalId)
        )
          throw new Error(
            "Credit allocation retry identity conflicts with the stored row.",
          );
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Credit allocation row was already applied.",
        };
        return;
      }
      if (!allocation && current)
        throw new Error(
          "A matching credit allocation was created after validation. Validate again.",
        );
      if (
        current &&
        (String(current.user) !== normalized.customerId ||
          String(current.currency) !== normalized.currency ||
          (normalized.externalId &&
            String(current.externalId || "") !== normalized.externalId) ||
          String(current.fingerprint || "") !==
            String(normalized.fingerprint || ""))
      )
        throw new Error("Credit allocation identity changed after validation.");
      if (
        current &&
        importSession.duplicateStrategy === DATA_IMPORT_DUPLICATE_STRATEGY.SKIP
      ) {
        result = {
          action: "skipped" as const,
          recordId: current._id,
          message: "Existing credit allocation skipped.",
        };
        return;
      }
      const target = Number(normalized.balanceMinor);
      if (!Number.isSafeInteger(target) || target < 0)
        throw new Error("Credit allocation target is invalid.");
      const recordId = current?._id || new mongoose.Types.ObjectId();
      const revision = current ? Number(current.revision) + 1 : 1;
      const prior = current ? Number(current.targetAmountMinor) : 0;
      const delta = target - prior;
      if (
        current &&
        String(current.importId) === sessionId &&
        prior === target
      ) {
        result = {
          action: "skipped" as const,
          recordId,
          message: "Credit allocation was already applied.",
        };
        return;
      }
      if (delta !== 0) {
        await moneyCreditService.changeBalance({
          tenantId,
          userId: normalized.customerId!,
          amountDelta:
            Math.sign(delta) *
            fromCurrencyMinorUnits(
              Math.abs(delta),
              normalized.currency as StudioCommerceCurrency,
            ),
          transaction: {
            type:
              delta > 0
                ? MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_CREDIT
                : MONEY_CREDIT_TRANSACTION_TYPE.MIGRATION_DEBIT,
            currency: normalized.currency as StudioCommerceCurrency,
            description: "Imported source credit allocation adjustment",
            adminId: importObjectId(actorId),
            reason: normalized.note || "migration",
            idempotencyKey: `credit-import:${recordId}:r${revision}`,
          },
          session: transaction,
        });
      }
      if (!current) {
        const created = await CreditImportAllocationModel.create(
          [
            {
              _id: recordId,
              tenant: importObjectId(tenantId),
              user: importObjectId(normalized.customerId),
              ...(normalized.externalId
                ? { externalId: normalized.externalId }
                : {}),
              fingerprint: normalized.fingerprint,
              importKey,
              source: importSession.fileType,
              importId: sessionId,
              lastMutationKey: importKey,
              targetAmountMinor: target,
              currency: normalized.currency,
              revision,
              note: normalized.note,
              importedAt: new Date(),
              importedBy: importObjectId(actorId),
            },
          ] as any,
          { session: transaction },
        );
        await recordDataImportMutation({
          tenantId,
          sessionId,
          rowId: row._id,
          rowNumber: row.rowNumber,
          entityType: DATA_IMPORT_ENTITY.CREDITS,
          mutationKey: importKey,
          operation: importMutationOperation.DELTA,
          importOutcome: "created",
          importMessage: "Credit source allocation imported.",
          targetId: created[0]._id,
          affectedFields: CREDIT_ALLOCATION_FIELDS,
          beforeRecord: null,
          afterRecord: created[0],
          delta: {
            kind: "money_credit",
            userId: normalized.customerId,
            currency: normalized.currency,
            amountMinor: delta,
            priorTargetAmountMinor: prior,
            targetAmountMinor: target,
            allocationRevision: revision,
            createdAllocation: true,
          },
          actorId,
          transaction,
        });
        result = {
          action: "created" as const,
          recordId: created[0]._id,
          message: "Credit source allocation imported.",
        };
        return;
      }
      const updated = await CreditImportAllocationModel.findOneAndUpdate(
        { _id: current._id, tenant: tenantId, revision: current.revision },
        {
          $set: {
            targetAmountMinor: target,
            revision,
            note: normalized.providedFields.includes("note")
              ? normalized.note
              : current.note,
            source: importSession.fileType,
            importId: sessionId,
            lastMutationKey: importKey,
            importedAt: new Date(),
            importedBy: importObjectId(actorId),
          },
        },
        { returnDocument: "after", session: transaction, runValidators: true },
      );
      if (!updated)
        throw new Error("Credit allocation revision changed after validation.");
      await recordDataImportMutation({
        tenantId,
        sessionId,
        rowId: row._id,
        rowNumber: row.rowNumber,
        entityType: DATA_IMPORT_ENTITY.CREDITS,
        mutationKey: importKey,
        operation: importMutationOperation.DELTA,
        importOutcome: "updated",
        importMessage:
          delta === 0
            ? "Credit allocation metadata updated."
            : "Credit allocation delta applied.",
        targetId: updated._id,
        affectedFields: CREDIT_ALLOCATION_FIELDS,
        beforeRecord: current,
        afterRecord: updated,
        delta: {
          kind: "money_credit",
          userId: normalized.customerId,
          currency: normalized.currency,
          amountMinor: delta,
          priorTargetAmountMinor: prior,
          targetAmountMinor: target,
          allocationRevision: revision,
          createdAllocation: false,
        },
        actorId,
        transaction,
      });
      result = {
        action: "updated" as const,
        recordId: updated._id,
        message:
          delta === 0
            ? "Credit allocation metadata updated."
            : "Credit allocation delta applied.",
      };
    });
    return result;
  } catch (error) {
    if (isImportDuplicateKey(error)) {
      allocation = await CreditImportAllocationModel.findOne({
        tenant: tenantId,
        importKey,
      }).lean();
      if (
        allocation &&
        allocation.lastMutationKey === importKey &&
        String(allocation.user) === normalized.customerId &&
        String(allocation.currency) === normalized.currency &&
        String(allocation.fingerprint) === normalized.fingerprint &&
        Number(allocation.targetAmountMinor) ===
          Number(normalized.balanceMinor) &&
        (!normalized.externalId ||
          String(allocation.externalId || "") === normalized.externalId)
      )
        return {
          action: "skipped" as const,
          recordId: allocation._id,
          message: "Credit allocation was already imported.",
        };
    }
    throw error;
  } finally {
    await transaction.endSession();
  }
};

export const processCreditImportSession = ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) =>
  processStagedImportSession({
    tenantId,
    sessionId,
    entityType: DATA_IMPORT_ENTITY.CREDITS,
    executeRow: executeCreditRow,
  });
