import type {
  ImportIssue,
  MembershipImportColumnMapping,
  NormalizedMembershipImportRow,
} from "../data-import.types.js";
import { normalizeImportPhone } from "./customer-import.adapter.js";
import {
  importToken,
  importValueAt,
  parseImportAmount,
  parseImportDateTime,
  parseImportInteger,
  parseNonnegativeIntegerMap,
} from "./import-adapter.utils.js";

const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });
const normalizeStatus = (value: string) => {
  const token = importToken(value);
  if (["active", "aktivni"].includes(token)) return "active";
  if (
    [
      "cancel-scheduled",
      "scheduled-cancellation",
      "zruseni-naplanovano",
    ].includes(token)
  )
    return "cancel_scheduled";
  if (["cancelled", "canceled", "zruseno", "stornovano"].includes(token))
    return "cancelled";
  if (["expired", "ended", "vyprselo", "ukonceno"].includes(token))
    return "expired";
  return token.replaceAll("-", "_");
};

export const normalizeMembershipImportRow = (
  raw: Record<string, string>,
  mapping: MembershipImportColumnMapping,
): NormalizedMembershipImportRow => {
  const value = (field: keyof MembershipImportColumnMapping) =>
    importValueAt(raw, mapping, field);
  const providedFields = (
    Object.keys(mapping) as Array<keyof MembershipImportColumnMapping>
  ).filter((field) => Boolean(mapping[field] && value(field)));
  const planVersionRaw = value("planVersion");
  const amountRaw = value("amount");
  const allowancesRaw = value("allowanceBalances");
  const startedAtRaw = value("startedAt");
  const periodStartRaw = value("periodStart");
  const periodEndRaw = value("periodEnd");
  const cancelledAtRaw = value("cancelledAt");
  const status = value("status") ? normalizeStatus(value("status")) : "active";
  const startedAt = parseImportDateTime(startedAtRaw, "start");
  const periodStart = parseImportDateTime(
    periodStartRaw ||
      (["cancelled", "expired"].includes(status) ? startedAtRaw : ""),
    "start",
  );
  const periodEnd = parseImportDateTime(periodEndRaw, "end");
  const cancelledAt = parseImportDateTime(cancelledAtRaw, "start");
  const planVersion = planVersionRaw
    ? parseImportInteger(planVersionRaw)
    : null;
  const amount = amountRaw ? parseImportAmount(amountRaw) : null;
  const allowanceBalances = allowancesRaw
    ? parseNonnegativeIntegerMap(allowancesRaw)
    : null;
  const parseErrors: NormalizedMembershipImportRow["parseErrors"] = [];
  if (planVersionRaw && planVersion === null) parseErrors.push("planVersion");
  if (startedAtRaw && !startedAt) parseErrors.push("startedAt");
  if (periodStartRaw && !periodStart) parseErrors.push("periodStart");
  if (periodEndRaw && !periodEnd) parseErrors.push("periodEnd");
  if (cancelledAtRaw && !cancelledAt) parseErrors.push("cancelledAt");
  if (amountRaw && amount === null) parseErrors.push("amount");
  if (allowancesRaw && allowanceBalances === null)
    parseErrors.push("allowanceBalances");
  const optional = (
    field: keyof MembershipImportColumnMapping,
    transformed = value(field),
  ) => (transformed ? { [field]: transformed } : {});
  return {
    ...optional("externalId"),
    ...optional("customerExternalId"),
    ...optional("customerEmail", value("customerEmail").toLocaleLowerCase()),
    ...optional("customerPhone", normalizeImportPhone(value("customerPhone"))),
    ...optional("planExternalId"),
    planName: value("planName"),
    planVersion,
    ...optional("locationCode", value("locationCode").toUpperCase()),
    ...optional("locationSlug", value("locationSlug").toLocaleLowerCase()),
    ...optional("locationName"),
    status,
    startedAt,
    periodStart,
    periodEnd,
    cancelledAt,
    currency: value("currency").toUpperCase(),
    amount,
    allowanceBalances,
    note: value("note"),
    providedFields,
    parseErrors,
  } as NormalizedMembershipImportRow;
};

export const membershipHasCustomerIdentity = (
  value: NormalizedMembershipImportRow,
) =>
  Boolean(
    value.customerExternalId || value.customerEmail || value.customerPhone,
  );
export const validateMembershipImportRow = (
  value: NormalizedMembershipImportRow,
  now = new Date(),
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!membershipHasCustomerIdentity(value))
    issues.push(
      error(
        "MEMBERSHIP_CUSTOMER_REQUIRED",
        "Map a customer external ID, email, or phone.",
      ),
    );
  if (!value.planExternalId && !value.planName)
    issues.push(
      error("MEMBERSHIP_PLAN_REQUIRED", "Map a plan external ID or name."),
    );
  if (
    !["active", "cancel_scheduled", "cancelled", "expired"].includes(
      value.status,
    )
  )
    issues.push(
      error(
        "MEMBERSHIP_STATUS_INVALID",
        "Status must be Active, Cancel scheduled, Cancelled, or Expired.",
        "status",
      ),
    );
  if (!value.startedAt)
    issues.push(
      error(
        "MEMBERSHIP_START_INVALID",
        "Start must be a valid timestamp or date.",
        "startedAt",
      ),
    );
  if (!value.periodStart)
    issues.push(
      error(
        "MEMBERSHIP_PERIOD_INVALID",
        "Current period start is required.",
        "periodStart",
      ),
    );
  if (!value.periodEnd)
    issues.push(
      error(
        "MEMBERSHIP_PERIOD_INVALID",
        "Current period end is required.",
        "periodEnd",
      ),
    );
  if (
    value.startedAt &&
    value.periodStart &&
    new Date(value.periodStart) < new Date(value.startedAt)
  )
    issues.push(
      error(
        "MEMBERSHIP_PERIOD_INVALID",
        "Current period cannot start before membership start.",
        "periodStart",
      ),
    );
  if (
    value.periodStart &&
    value.periodEnd &&
    new Date(value.periodEnd) <= new Date(value.periodStart)
  )
    issues.push(
      error(
        "MEMBERSHIP_PERIOD_INVALID",
        "Current period end must be after its start.",
        "periodEnd",
      ),
    );
  if (
    ["active", "cancel_scheduled"].includes(value.status) &&
    value.periodStart &&
    value.periodEnd &&
    !(new Date(value.periodStart) <= now && now < new Date(value.periodEnd))
  )
    issues.push(
      error(
        "MEMBERSHIP_ACTIVE_PERIOD_INVALID",
        "An open membership period must contain the current time.",
      ),
    );
  if (
    value.status === "expired" &&
    value.periodEnd &&
    new Date(value.periodEnd) > now
  )
    issues.push(
      error(
        "MEMBERSHIP_EXPIRED_PERIOD_INVALID",
        "An expired membership must end in the past.",
        "periodEnd",
      ),
    );
  if (value.status !== "cancelled" && value.cancelledAt)
    issues.push(
      error(
        "MEMBERSHIP_CANCELLED_AT_INVALID",
        "Only cancelled memberships may include a cancellation date.",
        "cancelledAt",
      ),
    );
  if (
    value.cancelledAt &&
    (new Date(value.cancelledAt) > now ||
      (value.startedAt &&
        new Date(value.cancelledAt) < new Date(value.startedAt)))
  )
    issues.push(
      error(
        "MEMBERSHIP_CANCELLED_AT_INVALID",
        "Cancellation date must be between membership start and now.",
        "cancelledAt",
      ),
    );
  if (
    value.planVersion !== null &&
    (!value.planVersion || value.planVersion < 1)
  )
    issues.push(
      error(
        "MEMBERSHIP_PLAN_VERSION_INVALID",
        "Plan version must be a positive whole number.",
        "planVersion",
      ),
    );
  if (value.amount !== null && value.amount < 0)
    issues.push(
      error(
        "MEMBERSHIP_AMOUNT_INVALID",
        "Membership amount cannot be negative.",
        "amount",
      ),
    );
  if (value.note.length > 1_000)
    issues.push(
      error("MEMBERSHIP_NOTE_TOO_LONG", "Membership note is too long.", "note"),
    );
  for (const field of value.parseErrors)
    if (!issues.some((issue) => issue.field === field))
      issues.push(
        error(
          "MEMBERSHIP_" +
            field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase() +
            "_INVALID",
          `Invalid ${field} value.`,
          field,
        ),
      );
  return issues;
};
export const membershipFileIdentityKeys = (
  value: NormalizedMembershipImportRow,
) => [
  ...(value.externalId
    ? [{ kind: "externalId", value: value.externalId }]
    : []),
  ...(value.fingerprint
    ? [{ kind: "fingerprint", value: value.fingerprint }]
    : []),
];
