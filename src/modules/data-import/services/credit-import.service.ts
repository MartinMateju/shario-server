import CreditImportAllocationModel from "@/modules/money-credit/credit-import-allocation.model.js";
import { resolveCreditBalanceMinor } from "@/modules/money-credit/money-credit.balance.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import {
  creditFileIdentityKeys,
  normalizeCreditImportRow,
  validateCreditImportRow,
} from "../adapters/credit-import.adapter.js";
import {
  DATA_IMPORT_ENTITY,
  type DataImportDuplicateStrategy,
} from "../data-import.constants.js";
import type {
  CreditImportColumnMapping,
  ImportIssue,
} from "../data-import.types.js";
import {
  addImportLookup,
  importError,
  importFingerprint,
  loadImportCustomerIndexes,
  registerImportFileIdentity,
  resolveImportCustomer,
  resolveUniqueImportLookup,
  toImportMinorUnits,
  type ImportLookupRecord,
} from "./import-domain-resolution.service.js";
import { createDataImportSession } from "./data-import.service.js";
import { assertValidCreditColumnMapping } from "./import-column-mapping.service.js";
import { validateStagedImportSession } from "./staged-import-validation.service.js";
import {
  isRolledBackImportRecord,
  rolledBackImportIssue,
} from "./data-import-rollback-marker.service.js";

export const createCreditImportSession = (args: {
  tenantId: string;
  actorId: string;
  file: Express.Multer.File;
}) =>
  createDataImportSession({ ...args, entityType: DATA_IMPORT_ENTITY.CREDITS });
export const validateCreditImportSession = (args: {
  tenantId: string;
  sessionId: string;
  mapping: unknown;
  duplicateStrategy: DataImportDuplicateStrategy;
  actorId: string;
  tenantCurrency: string;
}) =>
  validateStagedImportSession<CreditImportColumnMapping>({
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    entityType: DATA_IMPORT_ENTITY.CREDITS,
    mappingInput: args.mapping,
    duplicateStrategy: args.duplicateStrategy,
    actorId: args.actorId,
    assertMapping: assertValidCreditColumnMapping,
    validationContext: { tenantCurrency: args.tenantCurrency },
    prepare: async ({ rows, mapping }) => {
      const [customers, allocations, creditRecords, usersWithTransactions] =
        await Promise.all([
          loadImportCustomerIndexes(args.tenantId),
          CreditImportAllocationModel.find({ tenant: args.tenantId }).lean(),
          MoneyCredit.find({ tenant: args.tenantId })
            .select("user balance balanceMinor currency")
            .lean(),
          MoneyCredit.find({
            tenant: args.tenantId,
            "transactions.0": { $exists: true },
          })
            .select("user")
            .lean(),
        ]);
      const external = new Map<string, ImportLookupRecord[]>(),
        fingerprints = new Map<string, ImportLookupRecord[]>();
      for (const allocation of allocations as ImportLookupRecord[]) {
        addImportLookup(
          external,
          String(allocation.externalId || "").trim(),
          allocation,
        );
        addImportLookup(
          fingerprints,
          String(allocation.fingerprint || "").trim(),
          allocation,
        );
      }
      const creditByUser = new Map(
          (creditRecords as ImportLookupRecord[]).map((record) => [
            String(record.user),
            record,
          ]),
        ),
        nonEmptyUsers = new Set(
          (usersWithTransactions as ImportLookupRecord[]).map((record) =>
            String(record.user),
          ),
        ),
        fileKeys = new Map<string, number>();
      return rows.map((row) => {
        const normalized = normalizeCreditImportRow(
          row.raw as Record<string, string>,
          mapping,
        );
        normalized.currency ||= args.tenantCurrency;
        const issues: ImportIssue[] = validateCreditImportRow(normalized);
        if (normalized.currency !== args.tenantCurrency)
          issues.push(
            importError(
              "CREDIT_CURRENCY_MISMATCH",
              "Credit currency must match workspace currency.",
              "currency",
            ),
          );
        const target =
          normalized.balance === null
            ? null
            : toImportMinorUnits(
                normalized.balance,
                normalized.currency as StudioCommerceCurrency,
              );
        if (target === null)
          issues.push(
            importError(
              "CREDIT_BALANCE_PRECISION_INVALID",
              "Opening allocation has invalid currency precision.",
              "balance",
            ),
          );
        else normalized.balanceMinor = target;
        const customer = resolveImportCustomer(normalized, customers);
        if (customer.ambiguous)
          issues.push(
            importError(
              "CREDIT_CUSTOMER_IDENTITY_CONFLICT",
              "Customer identifiers match different or ambiguous users.",
            ),
          );
        else if (!customer.record)
          issues.push(
            importError(
              "CREDIT_CUSTOMER_NOT_FOUND",
              "Customer could not be resolved.",
            ),
          );
        else {
          normalized.customerId = String(customer.record._id);
          normalized.fingerprint = importFingerprint(
            "credit-allocation-v1",
            args.tenantId,
            normalized.customerId,
          );
        }
        let liveBalance = 0;
        if (customer.record && normalized.customerId)
          try {
            liveBalance = resolveCreditBalanceMinor({
              moneyCreditsMinor: customer.record.moneyCreditsMinor,
              moneyCredits: customer.record.moneyCredits,
              currency: normalized.currency as StudioCommerceCurrency,
            });
            const ledger = creditByUser.get(normalized.customerId);
            if (ledger) {
              const ledgerCurrency = String(
                  ledger.currency || "",
                ).toUpperCase(),
                ledgerBalance = resolveCreditBalanceMinor({
                  moneyCreditsMinor: ledger.balanceMinor,
                  moneyCredits: ledger.balance,
                  currency: ledgerCurrency as StudioCommerceCurrency,
                });
              if (
                ledgerCurrency !== normalized.currency &&
                (liveBalance ||
                  ledgerBalance ||
                  nonEmptyUsers.has(normalized.customerId))
              )
                issues.push(
                  importError(
                    "CREDIT_LEDGER_CURRENCY_MISMATCH",
                    "The non-empty credit ledger uses another currency.",
                    "currency",
                  ),
                );
              else if (
                ledgerCurrency === normalized.currency &&
                ledgerBalance !== liveBalance
              )
                issues.push(
                  importError(
                    "CREDIT_LEDGER_BALANCE_MISMATCH",
                    "Customer and ledger balance mirrors disagree.",
                    "balance",
                  ),
                );
            }
          } catch {
            issues.push(
              importError(
                "CREDIT_LEDGER_BALANCE_INVALID",
                "The current credit balance cannot be resolved.",
              ),
            );
          }
        const match = resolveUniqueImportLookup([
          {
            records: normalized.externalId
              ? external.get(normalized.externalId)
              : undefined,
            kind: "externalId",
          },
          {
            records: normalized.fingerprint
              ? fingerprints.get(normalized.fingerprint)
              : undefined,
            kind: "fingerprint",
          },
        ]);
        if (isRolledBackImportRecord(match.record))
          issues.push({ ...rolledBackImportIssue });
        if (
          match.ambiguous ||
          (match.record &&
            (String(match.record.user) !== normalized.customerId ||
              String(match.record.currency) !== normalized.currency ||
              (normalized.externalId &&
                String(match.record.externalId || "") !==
                  normalized.externalId) ||
              String(match.record.fingerprint || "") !==
                String(normalized.fingerprint || "")))
        )
          issues.push(
            importError(
              "CREDIT_IMPORT_ALLOCATION_IDENTITY_CONFLICT",
              "Allocation identifiers belong to different customer or currency records.",
            ),
          );
        if (
          match.record &&
          target !== null &&
          target < Number(match.record.targetAmountMinor) &&
          Number(match.record.targetAmountMinor) - target > liveBalance
        )
          issues.push(
            importError(
              "CREDIT_IMPORT_ALLOCATION_DELTA_INSUFFICIENT",
              "Lowering this source allocation would make the wallet negative.",
              "balance",
            ),
          );
        let duplicate: any = match.record
          ? {
              kind: match.kind || "fingerprint",
              existingRecordId: match.record._id,
            }
          : null;
        const fileDuplicate = registerImportFileIdentity({
          keys: [
            ...(match.record
              ? [{ kind: "existingRecord", value: String(match.record._id) }]
              : []),
            ...creditFileIdentityKeys(normalized),
          ],
          rowNumber: row.rowNumber,
          fileKeys,
          issues,
          issueCode: "CREDIT_DUPLICATE_IN_FILE",
          issueMessage:
            "This customer credit allocation already appears earlier in the file.",
        });
        if (fileDuplicate) duplicate = fileDuplicate;
        return { normalized, issues, duplicate };
      });
    },
  });
