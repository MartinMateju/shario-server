import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { DEFAULT_CREDIT_CURRENCY } from "./money-credit.constants.js";

export const normalizeCreditCurrency = (
  currency: unknown,
): StudioCommerceCurrency =>
  normalizeStudioCommerceCurrency(currency || DEFAULT_CREDIT_CURRENCY);

export const toMinorUnits = (
  amount: number,
  currency: unknown,
): number => {
  const normalizedCurrency = normalizeCreditCurrency(currency);

  return toCurrencyMinorUnits(amount, normalizedCurrency);
};
