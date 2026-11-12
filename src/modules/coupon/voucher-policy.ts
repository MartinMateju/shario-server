export type VoucherValidityPolicy =
  | { mode: "months"; months: number }
  | { mode: "date"; date: string }
  | { mode: "none" };

export type VoucherSettingsSnapshot = {
  version: 1;
  type: "value" | "experience";
  validity: VoucherValidityPolicy;
  experienceProductId?: string | null;
  experienceQuantity?: number;
  eligibleProductIds?: string[];
  physicalDelivery?: { enabled: boolean; postageFeeMinor: number };
};

export const DEFAULT_VOUCHER_VALIDITY: VoucherValidityPolicy = {
  mode: "months",
  months: 12,
};
export const VOUCHER_VALIDITY_MONTH_PRESETS = [3, 6, 8, 12] as const;

export const normalizeVoucherTimezone = (value: unknown): string => {
  const timezone = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("Voucher validity requires a valid workspace timezone.");
  }
  return timezone;
};

export const parseVoucherCalendarDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a valid YYYY-MM-DD expiry date.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 9998 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Use a valid calendar expiry date.");
  }
  return { year, month, day };
};

export const normalizeVoucherSettings = (value?: unknown): VoucherSettingsSnapshot => {
  if (value === undefined || value === null) return { version: 1, type: "value", validity: { ...DEFAULT_VOUCHER_VALIDITY } };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voucher settings.");
  const input = value as Record<string, any>;
  if (input.version !== 1 || !["value", "experience"].includes(input.type)) throw new Error("Invalid voucher settings version or type.");
  const validity = input.validity;
  if (!validity || typeof validity !== "object") throw new Error("Voucher validity is required.");
  let policy: VoucherValidityPolicy;
  if (validity.mode === "months") {
    if (!Number.isInteger(validity.months) || validity.months < 1 || validity.months > 120) throw new Error("Voucher validity must be between 1 and 120 months.");
    policy = { mode: "months", months: validity.months };
  } else if (validity.mode === "date") {
    parseVoucherCalendarDate(validity.date);
    policy = { mode: "date", date: validity.date };
  } else if (validity.mode === "none") {
    policy = { mode: "none" };
  } else throw new Error("Invalid voucher validity mode.");
  const physicalDelivery = input.physicalDelivery;
  if (physicalDelivery !== undefined && (
    !physicalDelivery || typeof physicalDelivery !== "object" ||
    typeof physicalDelivery.enabled !== "boolean" ||
    !Number.isSafeInteger(physicalDelivery.postageFeeMinor) ||
    physicalDelivery.postageFeeMinor < 0 || physicalDelivery.postageFeeMinor > 100_000_000
  )) throw new Error("Invalid voucher postal delivery settings.");
  return {
    version: 1,
    type: input.type,
    validity: policy,
    ...(input.experienceProductId ? { experienceProductId: String(input.experienceProductId) } : {}),
    ...(input.experienceQuantity !== undefined ? { experienceQuantity: input.experienceQuantity } : {}),
    ...(Array.isArray(input.eligibleProductIds) ? { eligibleProductIds: input.eligibleProductIds.map(String) } : {}),
    ...(physicalDelivery !== undefined ? { physicalDelivery: {
      enabled: physicalDelivery.enabled, postageFeeMinor: physicalDelivery.postageFeeMinor,
    } } : {}),
  };
};

const calendarParts = (instant: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((value) => value.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
};

// Find the first instant whose local calendar date is after the selected day.
// A bounded binary search handles DST gaps, folds and midnight offset changes
// without relying on the process timezone or assuming every day is 24 hours.
const endOfCalendarDay = (year: number, month: number, day: number, timezone: string): Date => {
  const pivot = Date.UTC(year, month - 1, day);
  const target = year * 10000 + month * 100 + day;
  let low = pivot - 36 * 60 * 60 * 1000;
  let high = pivot + 60 * 60 * 60 * 1000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const local = calendarParts(new Date(middle), timezone);
    const stamp = local.year * 10000 + local.month * 100 + local.day;
    if (stamp <= target) low = middle + 1;
    else high = middle;
  }
  return new Date(low - 1);
};

export const calculateVoucherExpiry = (params: {
  validity?: VoucherValidityPolicy;
  issuedAt: Date;
  timezone?: string;
}): Date | null => {
  if (!Number.isFinite(params.issuedAt.getTime())) throw new Error("Invalid voucher issuance date.");
  const timezone = normalizeVoucherTimezone(params.timezone);
  const validity = normalizeVoucherSettings({ version: 1, type: "value", validity: params.validity ?? DEFAULT_VOUCHER_VALIDITY }).validity;
  if (validity.mode === "none") return null;
  if (validity.mode === "date") {
    const { year, month, day } = parseVoucherCalendarDate(validity.date);
    return endOfCalendarDay(year, month, day, timezone);
  }
  const local = calendarParts(params.issuedAt, timezone);
  const targetMonth = new Date(Date.UTC(local.year, local.month - 1 + validity.months, 1));
  const year = targetMonth.getUTCFullYear();
  const month = targetMonth.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return endOfCalendarDay(year, month, Math.min(local.day, lastDay), timezone);
};

export const assertVoucherCanBeIssued = (settings: VoucherSettingsSnapshot, issuedAt: Date, timezone: string) => {
  const expiresAt = calculateVoucherExpiry({ validity: settings.validity, issuedAt, timezone });
  if (expiresAt && expiresAt.getTime() <= issuedAt.getTime()) throw new Error("The voucher's custom expiry date has passed.");
  return expiresAt;
};
