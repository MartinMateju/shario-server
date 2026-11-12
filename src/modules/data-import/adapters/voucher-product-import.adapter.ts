import type {
  ImportIssue,
  NormalizedVoucherProductImportRow,
  VoucherProductImportColumnMapping,
} from "../data-import.types.js";
import {
  importValueAt,
  parseImportAmount,
  parseImportBoolean,
  parseImportInteger,
} from "./import-adapter.utils.js";
const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });
export const normalizeVoucherProductImportRow = (
  raw: Record<string, string>,
  mapping: VoucherProductImportColumnMapping,
): NormalizedVoucherProductImportRow => {
  const value = (field: keyof VoucherProductImportColumnMapping) =>
    importValueAt(raw, mapping, field);
  const providedFields = (
    Object.keys(mapping) as Array<keyof VoucherProductImportColumnMapping>
  ).filter((field) => Boolean(mapping[field] && value(field)));
  const amountRaw = value("value"),
    activeRaw = value("isActive"),
    sortRaw = value("sortOrder");
  const amount = amountRaw ? parseImportAmount(amountRaw) : null,
    isActive = activeRaw ? parseImportBoolean(activeRaw) : false,
    sortOrder = sortRaw ? parseImportInteger(sortRaw) : 0;
  const parseErrors: NormalizedVoucherProductImportRow["parseErrors"] = [];
  if (amountRaw && amount === null) parseErrors.push("value");
  if (activeRaw && isActive === null) parseErrors.push("isActive");
  if (sortRaw && sortOrder === null) parseErrors.push("sortOrder");
  return {
    ...(value("externalId") ? { externalId: value("externalId") } : {}),
    name: value("name"),
    description: value("description"),
    sku: value("sku"),
    value: amount,
    currency: value("currency").toUpperCase(),
    isActive,
    sortOrder,
    providedFields,
    parseErrors,
  };
};
export const validateVoucherProductImportRow = (
  value: NormalizedVoucherProductImportRow,
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!value.name)
    issues.push(
      error(
        "VOUCHER_PRODUCT_NAME_REQUIRED",
        "Voucher product name is required.",
        "name",
      ),
    );
  if (value.name.length > 160)
    issues.push(
      error(
        "VOUCHER_PRODUCT_NAME_TOO_LONG",
        "Voucher product name is too long.",
        "name",
      ),
    );
  if ((value.externalId?.length || 0) > 120)
    issues.push(
      error(
        "VOUCHER_PRODUCT_EXTERNAL_ID_TOO_LONG",
        "External ID is too long.",
        "externalId",
      ),
    );
  if (value.description.length > 2_000)
    issues.push(
      error(
        "VOUCHER_PRODUCT_DESCRIPTION_TOO_LONG",
        "Description is too long.",
        "description",
      ),
    );
  if (value.sku.length > 80)
    issues.push(
      error("VOUCHER_PRODUCT_SKU_TOO_LONG", "SKU is too long.", "sku"),
    );
  if (value.value === null || value.value <= 0)
    issues.push(
      error(
        "VOUCHER_PRODUCT_VALUE_INVALID",
        "Voucher value must be greater than zero.",
        "value",
      ),
    );
  for (const field of value.parseErrors)
    issues.push(
      error(
        "VOUCHER_PRODUCT_" +
          field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase() +
          "_INVALID",
        `Invalid ${field} value.`,
        field,
      ),
    );
  return issues;
};
export const voucherProductFileIdentityKeys = (
  value: NormalizedVoucherProductImportRow,
) => [
  ...(value.externalId
    ? [{ kind: "externalId", value: value.externalId }]
    : []),
  ...(value.sku ? [{ kind: "sku", value: value.sku.toLocaleLowerCase() }] : []),
  ...(value.name
    ? [{ kind: "name", value: value.name.toLocaleLowerCase() }]
    : []),
];
