import { PROMO_CODE_REGEX } from "@/modules/coupon/coupon.constants.js";
import type {
  ImportIssue,
  NormalizedVoucherImportRow,
  VoucherImportColumnMapping,
} from "../data-import.types.js";
import { normalizeImportPhone } from "./customer-import.adapter.js";
import {
  importToken,
  importValueAt,
  parseImportAmount,
  parseImportDateTime,
} from "./import-adapter.utils.js";
const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });
const normalizeStatus = (value: string) => {
  const token = importToken(value);
  if (["active", "valid", "aktivni", "platny"].includes(token)) return "active";
  if (["inactive", "disabled", "neaktivni", "deaktivovano"].includes(token))
    return "disabled";
  if (["redeemed", "used", "uplatneno", "pouzito"].includes(token))
    return "redeemed";
  if (["expired", "vyprselo", "expirovano"].includes(token)) return "expired";
  return token;
};
export const normalizeVoucherImportRow = (
  raw: Record<string, string>,
  mapping: VoucherImportColumnMapping,
): NormalizedVoucherImportRow => {
  const value = (field: keyof VoucherImportColumnMapping) =>
    importValueAt(raw, mapping, field);
  const providedFields = (
    Object.keys(mapping) as Array<keyof VoucherImportColumnMapping>
  ).filter((field) => Boolean(mapping[field] && value(field)));
  const valueRaw = value("value"),
    expiresRaw = value("expiresAt"),
    redeemedRaw = value("redeemedAt");
  const voucherValue = valueRaw ? parseImportAmount(valueRaw) : null,
    expiresAt = parseImportDateTime(expiresRaw, "end"),
    redeemedAt = parseImportDateTime(redeemedRaw, "start");
  const parseErrors: NormalizedVoucherImportRow["parseErrors"] = [];
  if (valueRaw && voucherValue === null) parseErrors.push("value");
  if (expiresRaw && !expiresAt) parseErrors.push("expiresAt");
  if (redeemedRaw && !redeemedAt) parseErrors.push("redeemedAt");
  return {
    ...(value("externalId") ? { externalId: value("externalId") } : {}),
    promoCode: value("promoCode").toUpperCase(),
    ...(value("productExternalId")
      ? { productExternalId: value("productExternalId") }
      : {}),
    ...(value("productSku") ? { productSku: value("productSku") } : {}),
    ...(value("productName") ? { productName: value("productName") } : {}),
    status: value("status") ? normalizeStatus(value("status")) : "active",
    value: voucherValue,
    currency: value("currency").toUpperCase(),
    expiresAt,
    redeemedAt,
    ...(value("customerExternalId")
      ? { customerExternalId: value("customerExternalId") }
      : {}),
    ...(value("customerEmail")
      ? { customerEmail: value("customerEmail").toLocaleLowerCase() }
      : {}),
    ...(value("customerPhone")
      ? { customerPhone: normalizeImportPhone(value("customerPhone")) }
      : {}),
    note: value("note"),
    providedFields,
    parseErrors,
  };
};
export const voucherHasCustomerIdentity = (value: NormalizedVoucherImportRow) =>
  Boolean(
    value.customerExternalId || value.customerEmail || value.customerPhone,
  );
export const validateVoucherImportRow = (
  value: NormalizedVoucherImportRow,
  now = new Date(),
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!PROMO_CODE_REGEX.test(value.promoCode))
    issues.push(
      error(
        "VOUCHER_CODE_INVALID",
        "Voucher code must contain 8-64 uppercase letters, numbers, or single hyphens.",
        "promoCode",
      ),
    );
  if (!value.productExternalId && !value.productSku && !value.productName)
    issues.push(
      error(
        "VOUCHER_PRODUCT_REQUIRED",
        "Map a voucher product external ID, SKU, or name.",
      ),
    );
  if (!["active", "disabled", "redeemed", "expired"].includes(value.status))
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "Status must be Active, Disabled, Redeemed, or Expired.",
        "status",
      ),
    );
  if (value.value === null || value.value <= 0)
    issues.push(
      error(
        "VOUCHER_SNAPSHOT_INVALID",
        "Voucher value must be greater than zero.",
        "value",
      ),
    );
  if (value.status === "redeemed" && !value.redeemedAt)
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "Redeemed vouchers require a redemption date.",
        "redeemedAt",
      ),
    );
  if (value.redeemedAt && new Date(value.redeemedAt) > now)
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "Redemption date cannot be in the future.",
        "redeemedAt",
      ),
    );
  if (
    value.status === "expired" &&
    (!value.expiresAt || new Date(value.expiresAt) > now)
  )
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "Expired vouchers require an expiry date in the past.",
        "expiresAt",
      ),
    );
  if (
    value.status === "active" &&
    value.expiresAt &&
    new Date(value.expiresAt) <= now
  )
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "An active voucher cannot already be expired.",
        "expiresAt",
      ),
    );
  if (
    value.status === "disabled" &&
    value.expiresAt &&
    new Date(value.expiresAt) <= now
  )
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "A disabled voucher with a past expiry must be imported as Expired.",
        "status",
      ),
    );
  if (
    value.status !== "redeemed" &&
    (value.redeemedAt || voucherHasCustomerIdentity(value))
  )
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "Only redeemed vouchers may include redemption data.",
      ),
    );
  if (
    value.redeemedAt &&
    value.expiresAt &&
    new Date(value.redeemedAt) > new Date(value.expiresAt)
  )
    issues.push(
      error(
        "VOUCHER_STATE_INVALID",
        "A voucher cannot be redeemed after expiry.",
        "redeemedAt",
      ),
    );
  if ((value.externalId?.length || 0) > 120)
    issues.push(
      error(
        "VOUCHER_EXTERNAL_ID_TOO_LONG",
        "External ID is too long.",
        "externalId",
      ),
    );
  if (value.note.length > 1_000)
    issues.push(
      error("VOUCHER_NOTE_TOO_LONG", "Voucher note is too long.", "note"),
    );
  for (const field of value.parseErrors)
    if (!issues.some((issue) => issue.field === field))
      issues.push(
        error(
          "VOUCHER_" +
            field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase() +
            "_INVALID",
          `Invalid ${field} value.`,
          field,
        ),
      );
  return issues;
};
export const voucherFileIdentityKeys = (value: NormalizedVoucherImportRow) => [
  ...(value.externalId
    ? [{ kind: "externalId", value: value.externalId }]
    : []),
  ...(value.promoCode ? [{ kind: "promoCode", value: value.promoCode }] : []),
];
