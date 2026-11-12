import { TENANT_ROLE } from "@/modules/user/user.constants.js";

export type StoredInvoiceNumbering = {
  number?: unknown;
  series?: unknown;
  sequence?: unknown;
};

export type InvoiceNumberingBackfillDecision =
  | {
      status: "candidate";
      series: string;
      sequence: number;
      set: { series?: string; sequence?: number };
    }
  | {
      status: "complete" | "unparsable" | "conflict";
      reason?: string;
    };

/** Parse the persisted `<series>-<positive integer>` format exactly. */
export const parseStoredInvoiceNumber = (
  number: unknown,
): { series: string; sequence: number } | null => {
  const value = String(number ?? "").trim().toUpperCase();
  const match = /^([A-Z0-9_-]{1,40})-(\d+)$/.exec(value);
  if (!match) return null;

  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;

  return { series: match[1], sequence };
};

export const getInvoiceNumberingBackfillDecision = (
  invoice: StoredInvoiceNumbering,
): InvoiceNumberingBackfillDecision => {
  const parsed = parseStoredInvoiceNumber(invoice.number);
  if (!parsed) {
    return { status: "unparsable", reason: "NUMBER_FORMAT_UNPARSABLE" };
  }

  const storedSeries = String(invoice.series ?? "").trim().toUpperCase();
  const storedSequence =
    invoice.sequence === null || invoice.sequence === undefined
      ? null
      : Number(invoice.sequence);

  if (storedSeries && storedSeries !== parsed.series) {
    return { status: "conflict", reason: "SERIES_MISMATCH" };
  }
  if (storedSequence !== null && storedSequence !== parsed.sequence) {
    return { status: "conflict", reason: "SEQUENCE_MISMATCH" };
  }
  if (storedSeries && storedSequence !== null) {
    return { status: "complete" };
  }

  return {
    status: "candidate",
    series: parsed.series,
    sequence: parsed.sequence,
    set: {
      ...(!storedSeries ? { series: parsed.series } : {}),
      ...(storedSequence === null ? { sequence: parsed.sequence } : {}),
    },
  };
};

const identityValue = (value: unknown): string =>
  String(value ?? "").trim();

const emailValue = (value: unknown): string =>
  identityValue(value).toLowerCase();

export const getIssuedCustomerLinkMismatchReasons = ({
  snapshot,
  user,
}: {
  snapshot: any;
  user: any | null;
}): string[] => {
  if (!user) return ["CUSTOMER_USER_MISSING"];

  const reasons: string[] = [];
  if (user.tenantRole !== TENANT_ROLE.CUSTOMER) {
    reasons.push("CUSTOMER_ROLE_INVALID");
  }
  if (identityValue(snapshot?.firstname) !== identityValue(user.firstname)) {
    reasons.push("FIRSTNAME_MISMATCH");
  }
  if (identityValue(snapshot?.lastname) !== identityValue(user.lastname)) {
    reasons.push("LASTNAME_MISMATCH");
  }
  if (emailValue(snapshot?.email) !== emailValue(user.email)) {
    reasons.push("EMAIL_MISMATCH");
  }
  if (identityValue(snapshot?.phone) !== identityValue(user.phone)) {
    reasons.push("PHONE_MISMATCH");
  }

  return reasons;
};
