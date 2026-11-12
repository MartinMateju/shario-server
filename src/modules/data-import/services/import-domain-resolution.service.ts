import { createHash } from "node:crypto";
import UserModel from "@/modules/user/user.model.js";
import {
  fromCurrencyMinorUnits,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { normalizeImportPhone } from "../adapters/customer-import.adapter.js";
import type { ImportIssue } from "../data-import.types.js";

export type ImportLookupRecord = { _id: any; [key: string]: any };
export const addImportLookup = <T>(
  map: Map<string, T[]>,
  key: string,
  value: T,
) => {
  if (key) map.set(key, [...(map.get(key) || []), value]);
};
export const resolveUniqueImportLookup = (
  candidates: Array<{ records?: ImportLookupRecord[]; kind: string }>,
) => {
  const matches = new Map<
    string,
    { record: ImportLookupRecord; kind: string }
  >();
  let ambiguous = false;
  for (const candidate of candidates) {
    if (!candidate.records?.length) continue;
    if (candidate.records.length > 1) ambiguous = true;
    for (const record of candidate.records)
      matches.set(String(record._id), { record, kind: candidate.kind });
  }
  if (ambiguous || matches.size > 1)
    return { record: null, kind: null, ambiguous: true };
  const match = [...matches.values()][0];
  return {
    record: match?.record || null,
    kind: match?.kind || null,
    ambiguous: false,
  };
};
export const loadImportCustomerIndexes = async (tenantId: string) => {
  const users = (await UserModel.find({ tenant: tenantId })
    .select(
      "_id firstname lastname customId email phone importMetadata.externalId moneyCredits moneyCreditsMinor membershipCredits membershipCreditsExpireAt +tenantRole +roles",
    )
    .lean()) as ImportLookupRecord[];
  const externalId = new Map<string, ImportLookupRecord[]>(),
    email = new Map<string, ImportLookupRecord[]>(),
    phone = new Map<string, ImportLookupRecord[]>();
  for (const user of users) {
    addImportLookup(
      externalId,
      String(user.importMetadata?.externalId || "").trim(),
      user,
    );
    addImportLookup(
      email,
      String(user.email || "")
        .trim()
        .toLocaleLowerCase(),
      user,
    );
    addImportLookup(
      phone,
      normalizeImportPhone(String(user.phone || "")),
      user,
    );
  }
  return { users, externalId, email, phone };
};
export const resolveImportCustomer = (
  row: {
    customerExternalId?: string;
    customerEmail?: string;
    customerPhone?: string;
  },
  indexes: Awaited<ReturnType<typeof loadImportCustomerIndexes>>,
) =>
  resolveUniqueImportLookup([
    {
      records: row.customerExternalId
        ? indexes.externalId.get(row.customerExternalId)
        : undefined,
      kind: "customerExternalId",
    },
    {
      records: row.customerEmail
        ? indexes.email.get(row.customerEmail.toLocaleLowerCase())
        : undefined,
      kind: "customerEmail",
    },
    {
      records: row.customerPhone
        ? indexes.phone.get(normalizeImportPhone(row.customerPhone))
        : undefined,
      kind: "customerPhone",
    },
  ]);
export const importFingerprint = (...parts: unknown[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        parts.map((part) =>
          String(part ?? "")
            .trim()
            .toLocaleLowerCase(),
        ),
      ),
    )
    .digest("hex");
export const toImportMinorUnits = (
  amount: number,
  currency: StudioCommerceCurrency,
): number | null => {
  try {
    const minor = toCurrencyMinorUnits(amount, currency);
    return fromCurrencyMinorUnits(minor, currency) === amount ? minor : null;
  } catch {
    return null;
  }
};
export const importError = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });
export const importWarning = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "warning" });
export const registerImportFileIdentity = ({
  keys,
  rowNumber,
  fileKeys,
  issues,
  issueCode,
  issueMessage,
}: {
  keys: Array<{ kind: string; value: string }>;
  rowNumber: number;
  fileKeys: Map<string, number>;
  issues: ImportIssue[];
  issueCode: string;
  issueMessage: string;
}) => {
  if (issues.some((issue) => issue.severity === "error") || !keys.length)
    return null;
  const earlier = new Set(
    keys
      .map((key) => fileKeys.get(`${key.kind}:${key.value}`))
      .filter((value): value is number => value !== undefined),
  );
  if (earlier.size > 1) {
    issues.push(
      importError(
        issueCode.replace(/DUPLICATE.*$/, "IDENTITY_CONFLICT"),
        "Identifiers match different earlier rows in this file.",
      ),
    );
    return null;
  }
  const duplicate =
    earlier.size === 1
      ? { kind: "file" as const, rowNumber: [...earlier][0] }
      : null;
  if (duplicate) issues.push(importWarning(issueCode, issueMessage));
  const identityRow = duplicate?.rowNumber || rowNumber;
  for (const key of keys)
    if (!fileKeys.has(`${key.kind}:${key.value}`))
      fileKeys.set(`${key.kind}:${key.value}`, identityRow);
  return duplicate;
};
