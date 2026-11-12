import { badRequest, conflict } from "@/shared/http/httpErrors.js";

import { requireCurrencyMinorUnits } from "./amount.js";
import {
  isStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "./currency.js";

export const assertCurrencyAmountFields = (
  fields: Record<string, number | undefined>,
  currency: StudioCommerceCurrency,
): void => {
  for (const [field, amount] of Object.entries(fields)) {
    if (amount === undefined) {
      continue;
    }

    try {
      requireCurrencyMinorUnits(amount, currency);
    } catch (error) {
      badRequest({
        message: `${field} is not a valid ${currency} amount.`,
        code: "INVALID_CURRENCY_AMOUNT",
        details: {
          field,
          currency,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
};

export type FinancialCurrencyResolution = {
  currency: StudioCommerceCurrency;
  persistSnapshot: boolean;
};

/**
 * Resolves the denomination for an update to a financial record.
 *
 * Legacy records with non-zero amounts are deliberately not assigned the
 * tenant's current currency: doing that would relabel history without proof.
 * They remain readable and may receive non-financial updates, but changing
 * their money fields requires an explicit accounting migration first.
 */
export const resolveFinancialRecordCurrency = ({
  tenantCurrency,
  recordCurrency,
  existingAmounts,
}: {
  tenantCurrency: StudioCommerceCurrency;
  recordCurrency: unknown;
  existingAmounts: number[];
}): FinancialCurrencyResolution => {
  const normalizedRecordCurrency = isStudioCommerceCurrency(recordCurrency)
    ? String(recordCurrency).trim().toUpperCase() as StudioCommerceCurrency
    : null;

  if (normalizedRecordCurrency === tenantCurrency) {
    return {
      currency: tenantCurrency,
      persistSnapshot: false,
    };
  }

  const hasHistoricalAmount = existingAmounts.some(
    (amount) => !Number.isFinite(amount) || amount !== 0,
  );

  if (!hasHistoricalAmount) {
    return {
      currency: tenantCurrency,
      persistSnapshot: true,
    };
  }

  if (!normalizedRecordCurrency) {
    conflict({
      message:
        "This legacy record has monetary values but no currency snapshot. Migrate it before changing monetary fields.",
      code: "LEGACY_CURRENCY_SNAPSHOT_REQUIRED",
      details: { tenantCurrency },
    });
  }

  conflict({
    message:
      "The record currency differs from the workspace currency. Migrate it before changing monetary fields.",
    code: "FINANCIAL_RECORD_CURRENCY_MISMATCH",
    details: {
      recordCurrency: normalizedRecordCurrency,
      tenantCurrency,
    },
  });
};
