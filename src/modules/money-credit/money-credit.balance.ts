import {
  fromCurrencyMinorUnits,
  getCurrencyExponent,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
const parseStoredMinorUnits = (value: unknown): number | null => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
export const legacyCreditMajorToMinorUnits = (
  value: unknown,
  currency: StudioCommerceCurrency,
): number => {
  const major = Number(value ?? 0);
  if (!Number.isFinite(major) || major < 0)
    throw new Error("Invalid legacy credit balance.");
  const scaled = major * 10 ** getCurrencyExponent(currency),
    minor = Math.round(scaled);
  if (
    Math.abs(scaled - minor) > 1e-6 ||
    !Number.isSafeInteger(minor) ||
    minor < 0
  )
    throw new Error("Legacy credit balance has unsupported precision.");
  return minor;
};
export const resolveCreditBalanceMinor = ({
  moneyCreditsMinor,
  moneyCredits,
  currency,
}: {
  moneyCreditsMinor?: unknown;
  moneyCredits?: unknown;
  currency: StudioCommerceCurrency;
}) =>
  parseStoredMinorUnits(moneyCreditsMinor) ??
  legacyCreditMajorToMinorUnits(moneyCredits, currency);
export const creditMinorToMajor = (
  amountMinor: number,
  currency: StudioCommerceCurrency,
) => fromCurrencyMinorUnits(amountMinor, currency);
export const hasValidCreditMinorSnapshot = (value: unknown) =>
  parseStoredMinorUnits(value) !== null;
