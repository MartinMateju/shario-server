import {
  fromCurrencyMinorUnits,
  getCurrencyExponent,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "./currency.js";

/**
 * Validates that a user-entered major-unit amount can be represented exactly
 * in the supplied currency. The returned value is useful at payment-provider
 * boundaries, but callers may ignore it when they only need validation.
 */
export const requireCurrencyMinorUnits = (
  amountMajor: number,
  currency: StudioCommerceCurrency,
): number => toCurrencyMinorUnits(amountMajor, currency);

/**
 * Rounds a calculated amount (for example VAT or a weighted average) to the
 * currency's minor-unit precision. Unlike user-entered amounts, calculated
 * values are expected to contain fractional minor units.
 */
export const roundDerivedCurrencyAmount = (
  amountMajor: number,
  currency: StudioCommerceCurrency,
): number => {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new Error(`Invalid derived money amount: ${String(amountMajor)}`);
  }

  const scaled = amountMajor * 10 ** getCurrencyExponent(currency);
  const floatingPointTolerance =
    Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const roundedMinor = Math.round(scaled + floatingPointTolerance);

  if (!Number.isSafeInteger(roundedMinor)) {
    throw new Error(
      `Derived money amount exceeds the safe integer range: ${amountMajor}`,
    );
  }

  return fromCurrencyMinorUnits(roundedMinor, currency);
};
