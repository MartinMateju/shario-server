import {
  EMAIL_REGEX,
  LEGACY_ROLE,
  TENANT_ROLE,
} from "@/modules/user/user.constants.js";

import type {
  ImportColumnMapping,
  ImportIssue,
  NormalizedCustomerImportRow,
} from "../data-import.types.js";

export const CUSTOMER_PASSWORD_HASH_HEADER =
  "Legacy Password Hash (bcrypt)" as const;
export const CUSTOMER_PASSWORD_REDACTED_VALUE = "[REDACTED]" as const;
export const CUSTOMER_PASSWORD_HASH_REGEX =
  /^\$2[aby]\$(0[8-9]|1[0-4])\$[./A-Za-z0-9]{53}$/;

export const isSupportedCustomerPasswordHash = (value: string): boolean =>
  CUSTOMER_PASSWORD_HASH_REGEX.test(value);

const valueAt = (
  raw: Record<string, string>,
  mapping: ImportColumnMapping,
  field: keyof ImportColumnMapping,
): string =>
  String(mapping[field] ? raw[mapping[field] as string] || "" : "").trim();

export const normalizeImportPhone = (value: string): string => {
  // Spreadsheet exports commonly prefix phone numbers with an apostrophe to
  // preserve the leading plus sign. Treat that marker as cell formatting,
  // not as part of the phone number.
  const trimmed = value.trim().replace(/^['’]\s*(?=\+)/, "");
  if (!trimmed) return "";
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D/g, "");
  return digits ? plus + digits : "";
};

export const normalizeImportedMemberNumber = (
  value: string,
): { provided: boolean; memberNumber?: number } => {
  const trimmed = value.trim();
  if (!trimmed) return { provided: false };

  const match = trimmed.match(/^#?(\d+)#?$/);
  if (!match) return { provided: true };
  const memberNumber = Number(match[1]);
  if (!Number.isSafeInteger(memberNumber) || memberNumber < 1) {
    return { provided: true };
  }

  return { provided: true, memberNumber };
};

export const isProtectedWorkspaceUser = (user: {
  tenantRole?: string;
  roles?: string[];
}): boolean =>
  (Boolean(user.tenantRole) && user.tenantRole !== TENANT_ROLE.CUSTOMER) ||
  Boolean(
    user.roles?.some(
      (role) => role === LEGACY_ROLE.ADMIN || role === LEGACY_ROLE.MODERATOR,
    ),
  );

const splitFullName = (value: string): [string, string] => {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return [parts[0] || "", ""];
  return [parts[0], parts.slice(1).join(" ")];
};

export const normalizeCustomerImportRow = (
  raw: Record<string, string>,
  mapping: ImportColumnMapping,
): NormalizedCustomerImportRow => {
  const fullName = valueAt(raw, mapping, "fullName");
  const [derivedFirst, derivedLast] = splitFullName(fullName);
  let firstname = valueAt(raw, mapping, "firstName") || derivedFirst;
  let lastname = valueAt(raw, mapping, "lastName") || derivedLast;
  if (!firstname && lastname) {
    firstname = lastname;
    lastname = "";
  }
  const email = valueAt(raw, mapping, "email").toLocaleLowerCase();
  const phone = normalizeImportPhone(valueAt(raw, mapping, "phone"));
  const importedMemberNumber = normalizeImportedMemberNumber(
    valueAt(raw, mapping, "memberNumber"),
  );
  const externalId = valueAt(raw, mapping, "externalId");
  return {
    firstname,
    lastname,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(importedMemberNumber.provided
      ? { memberNumberProvided: true }
      : {}),
    ...(importedMemberNumber.memberNumber
      ? { memberNumber: importedMemberNumber.memberNumber }
      : {}),
    ...(externalId ? { externalId } : {}),
  };
};

export const validateCustomerImportRow = (
  value: NormalizedCustomerImportRow,
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!value.firstname && !value.lastname) {
    issues.push({
      code: "CUSTOMER_NAME_REQUIRED",
      severity: "error",
      message: "Customer name is required.",
    });
  }
  if (value.firstname.length > 80) {
    issues.push({
      code: "CUSTOMER_FIRST_NAME_TOO_LONG",
      field: "firstName",
      severity: "error",
      message: "First name can contain at most 80 characters.",
    });
  }
  if (value.lastname.length > 80) {
    issues.push({
      code: "CUSTOMER_LAST_NAME_TOO_LONG",
      field: "lastName",
      severity: "error",
      message: "Last name can contain at most 80 characters.",
    });
  }
  if (
    value.email &&
    (!EMAIL_REGEX.test(value.email) || value.email.length > 254)
  ) {
    issues.push({
      code: "CUSTOMER_EMAIL_INVALID",
      field: "email",
      severity: "error",
      message: "Email address is invalid.",
    });
  }
  if (value.phone && value.phone.length > 40) {
    issues.push({
      code: "CUSTOMER_PHONE_TOO_LONG",
      field: "phone",
      severity: "error",
      message: "Phone number can contain at most 40 characters.",
    });
  }
  if (value.externalId && value.externalId.length > 120) {
    issues.push({
      code: "CUSTOMER_EXTERNAL_ID_TOO_LONG",
      field: "externalId",
      severity: "error",
      message: "External ID can contain at most 120 characters.",
    });
  }
  if (value.memberNumberProvided && !value.memberNumber) {
    issues.push({
      code: "CUSTOMER_MEMBER_NUMBER_INVALID",
      field: "memberNumber",
      severity: "error",
      message: "Member number must be a positive whole number.",
    });
  }
  if (!value.email) {
    issues.push({
      code: "CUSTOMER_EMAIL_MISSING",
      field: "email",
      severity: "warning",
      message: "No email address was provided.",
    });
  }
  if (value.passwordHashProvided && !value.email) {
    issues.push({
      code: "CUSTOMER_PASSWORD_HASH_WITHOUT_EMAIL",
      field: "passwordHash",
      severity: "error",
      message: "A legacy password hash requires an email address.",
    });
  }
  return issues;
};
