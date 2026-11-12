import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

type ExistingCreditTransaction = {
  idempotencyKey?: unknown;
  type?: unknown;
  amount?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
};

export const inspectCreditMutationIdempotency = ({
  transactions,
  idempotencyKey,
  type,
  amount,
  amountMinor,
  currency,
}: {
  transactions: readonly ExistingCreditTransaction[];
  idempotencyKey?: unknown;
  type: unknown;
  amount: number;
  amountMinor?: number;
  currency: StudioCommerceCurrency;
}): "missing" | "match" | "conflict" => {
  const key = String(idempotencyKey ?? "").trim();
  if (!key) return "missing";

  const existing = transactions.find(
    (transaction) => String(transaction.idempotencyKey ?? "") === key,
  );
  if (!existing) return "missing";

  const storedMinor = Number(existing.amountMinor);
  const hasStoredMinor =
    existing.amountMinor !== null &&
    existing.amountMinor !== undefined &&
    Number.isSafeInteger(storedMinor) &&
    storedMinor >= 0;
  const amountMatches =
    hasStoredMinor && Number.isSafeInteger(amountMinor)
      ? storedMinor === Math.abs(Number(amountMinor))
      : Number(existing.amount) === Math.abs(amount);

  return String(existing.type ?? "") === String(type ?? "") &&
    amountMatches &&
    String(existing.currency ?? "")
      .trim()
      .toUpperCase() === currency
    ? "match"
    : "conflict";
};
