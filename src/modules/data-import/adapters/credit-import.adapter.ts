import type {
  CreditImportColumnMapping,
  ImportIssue,
  NormalizedCreditImportRow,
} from "../data-import.types.js";
import { normalizeImportPhone } from "./customer-import.adapter.js";
import { importValueAt, parseImportAmount } from "./import-adapter.utils.js";
const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });
export const normalizeCreditImportRow = (
  raw: Record<string, string>,
  mapping: CreditImportColumnMapping,
): NormalizedCreditImportRow => {
  const value = (field: keyof CreditImportColumnMapping) =>
    importValueAt(raw, mapping, field);
  const providedFields = (
    Object.keys(mapping) as Array<keyof CreditImportColumnMapping>
  ).filter((field) => Boolean(mapping[field] && value(field)));
  const balanceRaw = value("balance");
  const balance = balanceRaw ? parseImportAmount(balanceRaw) : null;
  return {
    ...(value("externalId") ? { externalId: value("externalId") } : {}),
    ...(value("customerExternalId")
      ? { customerExternalId: value("customerExternalId") }
      : {}),
    ...(value("customerEmail")
      ? { customerEmail: value("customerEmail").toLocaleLowerCase() }
      : {}),
    ...(value("customerPhone")
      ? { customerPhone: normalizeImportPhone(value("customerPhone")) }
      : {}),
    balance,
    currency: value("currency").toUpperCase(),
    note: value("note"),
    providedFields,
    parseErrors: balanceRaw && balance === null ? ["balance"] : [],
  };
};
export const creditHasCustomerIdentity = (value: NormalizedCreditImportRow) =>
  Boolean(
    value.customerExternalId || value.customerEmail || value.customerPhone,
  );
export const validateCreditImportRow = (
  value: NormalizedCreditImportRow,
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!creditHasCustomerIdentity(value))
    issues.push(
      error(
        "CREDIT_CUSTOMER_REQUIRED",
        "Map a customer external ID, email, or phone.",
      ),
    );
  if (value.balance === null || value.balance < 0)
    issues.push(
      error(
        "CREDIT_BALANCE_INVALID",
        "Opening allocation must be a non-negative amount.",
        "balance",
      ),
    );
  if ((value.externalId?.length || 0) > 120)
    issues.push(
      error(
        "CREDIT_EXTERNAL_ID_TOO_LONG",
        "External ID is too long.",
        "externalId",
      ),
    );
  if (value.note.length > 1_000)
    issues.push(
      error("CREDIT_NOTE_TOO_LONG", "Credit note is too long.", "note"),
    );
  return issues;
};
export const creditFileIdentityKeys = (value: NormalizedCreditImportRow) => [
  ...(value.externalId
    ? [{ kind: "externalId", value: value.externalId }]
    : []),
  ...(value.fingerprint
    ? [{ kind: "fingerprint", value: value.fingerprint }]
    : []),
];
