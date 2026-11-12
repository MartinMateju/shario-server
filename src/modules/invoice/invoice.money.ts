import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { badRequest } from "@/shared/http/httpErrors.js";

export const assertMinorAmount = (value: unknown, label = "Amount"): number => {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0) {
    badRequest(`${label} must be a nonnegative minor-unit integer.`);
  }

  return amount;
};

export const assertTaxRateBps = (value: unknown): number => {
  const rate = Number(value);

  if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) {
    badRequest("Tax rate must be an integer between 0 and 10000 basis points.");
  }

  return rate;
};

export const calculateInclusiveTax = ({
  grossAmountMinor,
  taxRateBps,
}: {
  grossAmountMinor: number;
  taxRateBps: number;
}): { netAmountMinor: number; taxAmountMinor: number } => {
  const gross = assertMinorAmount(grossAmountMinor, "Gross amount");
  const rate = assertTaxRateBps(taxRateBps);

  if (rate === 0 || gross === 0) {
    return { netAmountMinor: gross, taxAmountMinor: 0 };
  }

  // Integer arithmetic avoids precision loss near Number.MAX_SAFE_INTEGER.
  // Adding half the divisor implements deterministic half-up rounding.
  const numerator = BigInt(gross) * 10000n;
  const divisor = 10000n + BigInt(rate);
  const roundedNet = (numerator + divisor / 2n) / divisor;
  if (roundedNet > BigInt(Number.MAX_SAFE_INTEGER)) {
    badRequest("Calculated tax exceeds the supported amount range.");
  }
  const netAmountMinor = Number(roundedNet);

  return {
    netAmountMinor,
    taxAmountMinor: gross - netAmountMinor,
  };
};

export const calculateCreditTaxSlice = ({
  originalGrossMinor,
  originalTaxMinor,
  creditedGrossMinor,
  creditedTaxMinor,
  creditGrossMinor,
}: {
  originalGrossMinor: number;
  originalTaxMinor: number;
  creditedGrossMinor: number;
  creditedTaxMinor: number;
  creditGrossMinor: number;
}): number => {
  const originalGross = assertMinorAmount(originalGrossMinor, "Original gross");
  const originalTax = assertMinorAmount(originalTaxMinor, "Original tax");
  const creditedGross = assertMinorAmount(creditedGrossMinor, "Credited gross");
  const creditedTax = assertMinorAmount(creditedTaxMinor, "Credited tax");
  const creditGross = assertMinorAmount(creditGrossMinor, "Credit gross");
  const remainingGross = originalGross - creditedGross;
  const remainingTax = originalTax - creditedTax;
  if (
    originalTax > originalGross ||
    remainingGross < 0 ||
    remainingTax < 0 ||
    creditGross > remainingGross
  ) {
    badRequest("Credit slice exceeds the remaining invoice line amount.");
  }
  if (creditGross === 0 || originalGross === 0) return 0;
  if (creditGross === remainingGross) return remainingTax;

  const numerator = BigInt(originalTax) * BigInt(creditGross);
  const divisor = BigInt(originalGross);
  const proportional = Number((numerator + divisor / 2n) / divisor);
  return Math.min(creditGross, remainingTax, proportional);
};

export const majorToMinor = (
  amount: unknown,
  currencyValue: unknown,
): number => {
  let currency: StudioCommerceCurrency;

  try {
    currency = normalizeStudioCommerceCurrency(currencyValue);
  } catch {
    badRequest("Invoice currency is not supported.");
  }

  try {
    return toCurrencyMinorUnits(Number(amount), currency);
  } catch {
    badRequest({
      message: `Amount has invalid precision for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
    });
  }
};

export const sumInvoiceLineTotals = (
  lines: Array<{
    netAmountMinor: number;
    taxAmountMinor: number;
    grossAmountMinor: number;
  }>,
) => {
  const totals = lines.reduce(
    (result, line) => ({
      netAmountMinor:
        result.netAmountMinor + assertMinorAmount(line.netAmountMinor),
      taxAmountMinor:
        result.taxAmountMinor + assertMinorAmount(line.taxAmountMinor),
      totalAmountMinor:
        result.totalAmountMinor + assertMinorAmount(line.grossAmountMinor),
    }),
    { netAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 0 },
  );

  for (const value of Object.values(totals)) {
    if (!Number.isSafeInteger(value)) {
      badRequest("Invoice total exceeds the supported amount range.");
    }
  }

  return totals;
};
