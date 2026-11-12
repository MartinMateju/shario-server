import { normalizeImportPhone } from "./customer-import.adapter.js";
import type {
  BookingImportColumnMapping,
  ImportIssue,
  NormalizedBookingImportRow,
} from "../data-import.types.js";

const valueAt = (
  raw: Record<string, string>,
  mapping: BookingImportColumnMapping,
  field: keyof BookingImportColumnMapping,
): string =>
  String(mapping[field] ? raw[mapping[field] as string] || "" : "").trim();

const normalizeToken = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/g, "-");

const parsePositiveInteger = (value: string): number | null => {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const BOOKING_STATUSES = new Set([
  "pending",
  "processed",
  "delivered",
  "cancelled",
  "completed",
]);

const normalizeStatus = (value: string): string => {
  const status = normalizeToken(value);
  if (["canceled", "stornovano", "zruseno"].includes(status))
    return "cancelled";
  if (["confirmed", "potvrzeno"].includes(status)) return "processed";
  return BOOKING_STATUSES.has(status) ? status : status;
};

const normalizeLanguage = (value: string): string => {
  const language = normalizeToken(value);
  if (["cz", "cs", "czech", "cesky", "cestina"].includes(language)) return "cs";
  if (["en", "english", "anglicky", "anglictina"].includes(language))
    return "en";
  return language;
};

const normalizeActivity = (value: string): string => {
  const activity = normalizeToken(value);
  if (["pottery-wheel", "wheel", "kruh", "toceni-na-kruhu"].includes(activity))
    return "WORKSTATION";
  if (
    [
      "modelling-glazing",
      "modeling-glazing",
      "modelling",
      "modeling",
      "glazing",
      "modelovani",
      "glazovani",
    ].includes(activity)
  )
    return "SHARED_TABLE";
  if (!activity || ["undefined", "none", "neuvedeno"].includes(activity))
    return "UNDEFINED";
  return value.trim().toUpperCase();
};

const normalizeSplitDate = (value: string): string => {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.exec(
    value,
  );
  return match?.[1] || value;
};

const normalizeSplitTime = (value: string): string => {
  const excelTime =
    /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  return excelTime?.[1] || value;
};

const hasExplicitOffset = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
    value,
  );

export const parseExplicitImportTimestamp = (value: string): string => {
  if (!hasExplicitOffset(value)) return "";
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day
  )
    return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
};

export const normalizeBookingImportRow = (
  raw: Record<string, string>,
  mapping: BookingImportColumnMapping,
): NormalizedBookingImportRow => {
  const providedFields: NormalizedBookingImportRow["providedFields"] = [];
  for (const field of Object.keys(mapping) as Array<
    keyof BookingImportColumnMapping
  >) {
    if (mapping[field] && valueAt(raw, mapping, field))
      providedFields.push(field);
  }
  const externalId = valueAt(raw, mapping, "externalId");
  const customerExternalId = valueAt(raw, mapping, "customerExternalId");
  const customerEmail = valueAt(
    raw,
    mapping,
    "customerEmail",
  ).toLocaleLowerCase();
  const customerPhone = normalizeImportPhone(
    valueAt(raw, mapping, "customerPhone"),
  );
  const productExternalId = valueAt(raw, mapping, "productExternalId");
  const productSku = valueAt(raw, mapping, "productSku");
  const productName = valueAt(raw, mapping, "productName");
  const locationCode = valueAt(raw, mapping, "locationCode").toUpperCase();
  const locationSlug = valueAt(
    raw,
    mapping,
    "locationSlug",
  ).toLocaleLowerCase();
  const locationName = valueAt(raw, mapping, "locationName");
  const startRaw = valueAt(raw, mapping, "start");
  const endRaw = valueAt(raw, mapping, "end");
  const date = normalizeSplitDate(valueAt(raw, mapping, "date"));
  const startTime = normalizeSplitTime(valueAt(raw, mapping, "startTime"));
  const endTime = normalizeSplitTime(valueAt(raw, mapping, "endTime"));
  const guestsRaw = valueAt(raw, mapping, "numberOfGuests");
  const statusRaw = valueAt(raw, mapping, "status");
  const languageRaw = valueAt(raw, mapping, "language");
  const parseErrors: NormalizedBookingImportRow["parseErrors"] = [];
  const start = startRaw ? parseExplicitImportTimestamp(startRaw) : "";
  const end = endRaw ? parseExplicitImportTimestamp(endRaw) : "";
  const numberOfGuests = guestsRaw ? parsePositiveInteger(guestsRaw) : 1;
  if (startRaw && !start) parseErrors.push("start");
  if (endRaw && !end) parseErrors.push("end");
  if (Boolean(startRaw) !== Boolean(endRaw)) {
    parseErrors.push(startRaw ? "end" : "start");
  }
  if (guestsRaw && numberOfGuests === null) parseErrors.push("numberOfGuests");

  return {
    ...(externalId ? { externalId } : {}),
    ...(customerExternalId ? { customerExternalId } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    ...(customerPhone ? { customerPhone } : {}),
    ...(productExternalId ? { productExternalId } : {}),
    ...(productSku ? { productSku } : {}),
    ...(productName ? { productName } : {}),
    ...(locationCode ? { locationCode } : {}),
    ...(locationSlug ? { locationSlug } : {}),
    ...(locationName ? { locationName } : {}),
    start,
    end,
    ...(date ? { date } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    numberOfGuests,
    numberOfGuestsProvided: Boolean(guestsRaw),
    status: statusRaw ? normalizeStatus(statusRaw) : "",
    language: languageRaw ? normalizeLanguage(languageRaw) : "",
    plannedActivity: normalizeActivity(
      valueAt(raw, mapping, "plannedActivity"),
    ),
    lecturer: valueAt(raw, mapping, "lecturer"),
    description: valueAt(raw, mapping, "description"),
    note: valueAt(raw, mapping, "note"),
    providedFields,
    parseErrors,
  };
};

const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });

export const validateBookingImportRow = (
  value: NormalizedBookingImportRow,
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  const hasAbsoluteRange = Boolean(value.start && value.end);
  const splitTime =
    !hasAbsoluteRange &&
    Boolean(value.date || value.startTime || value.endTime);
  if (value.parseErrors.includes("start"))
    issues.push(
      error(
        "BOOKING_START_INVALID",
        "Start must be an ISO-8601 timestamp with a timezone offset.",
        "start",
      ),
    );
  if (value.parseErrors.includes("end"))
    issues.push(
      error(
        "BOOKING_END_INVALID",
        "End must be an ISO-8601 timestamp with a timezone offset.",
        "end",
      ),
    );
  if (!hasAbsoluteRange && !splitTime)
    issues.push(
      error(
        "BOOKING_TIME_REQUIRED",
        "Map Start and End, or Date, Start time, and End time.",
      ),
    );
  if (splitTime && (!value.date || !value.startTime || !value.endTime))
    issues.push(
      error(
        "BOOKING_LOCAL_TIME_INCOMPLETE",
        "Local time imports require Date, Start time, and End time.",
      ),
    );
  if (
    value.start &&
    value.end &&
    new Date(value.end).getTime() <= new Date(value.start).getTime()
  )
    issues.push(
      error(
        "BOOKING_RANGE_INVALID",
        "Booking end must be after its start.",
        "end",
      ),
    );
  if (!value.productExternalId && !value.productSku && !value.productName)
    issues.push(
      error(
        "BOOKING_PRODUCT_REQUIRED",
        "A product external ID, SKU, or name is required.",
      ),
    );
  if (value.externalId && value.externalId.length > 120)
    issues.push(
      error(
        "BOOKING_EXTERNAL_ID_TOO_LONG",
        "External ID can contain at most 120 characters.",
        "externalId",
      ),
    );
  if (
    value.parseErrors.includes("numberOfGuests") ||
    value.numberOfGuests === null ||
    value.numberOfGuests > 500
  )
    issues.push(
      error(
        "BOOKING_GUESTS_INVALID",
        "Guests must be a whole number from 1 to 500.",
        "numberOfGuests",
      ),
    );
  if (value.status && !BOOKING_STATUSES.has(value.status))
    issues.push(
      error("BOOKING_STATUS_INVALID", "Booking status is invalid.", "status"),
    );
  if (value.language && !["cs", "en"].includes(value.language))
    issues.push(
      error(
        "BOOKING_LANGUAGE_INVALID",
        "Language must be Czech or English.",
        "language",
      ),
    );
  if (
    !["WORKSTATION", "SHARED_TABLE", "UNDEFINED"].includes(
      value.plannedActivity,
    )
  )
    issues.push(
      error(
        "BOOKING_ACTIVITY_INVALID",
        "Planned activity is invalid.",
        "plannedActivity",
      ),
    );
  if (value.lecturer.length > 200)
    issues.push(
      error(
        "BOOKING_LECTURER_TOO_LONG",
        "Lecturer can contain at most 200 characters.",
        "lecturer",
      ),
    );
  if (value.description.length > 5_000)
    issues.push(
      error(
        "BOOKING_DESCRIPTION_TOO_LONG",
        "Description can contain at most 5,000 characters.",
        "description",
      ),
    );
  if (value.note.length > 5_000)
    issues.push(
      error(
        "BOOKING_NOTE_TOO_LONG",
        "Note can contain at most 5,000 characters.",
        "note",
      ),
    );
  return issues;
};

export const bookingHasCustomerIdentity = (
  value: NormalizedBookingImportRow,
): boolean =>
  Boolean(
    value.customerExternalId || value.customerEmail || value.customerPhone,
  );
