import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
  isStudioCommerceCurrency,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

export type SupportedCurrency = Lowercase<StudioCommerceCurrency>;

export const ALLOWED_CURRENCIES = STUDIO_COMMERCE_CURRENCIES.map(
  (currency) => currency.toLowerCase() as SupportedCurrency,
) as readonly SupportedCurrency[];

export const DEFAULT_CURRENCY: SupportedCurrency =
  DEFAULT_STUDIO_COMMERCE_CURRENCY.toLowerCase() as SupportedCurrency;

/**
 * Stripe's published minimum non-zero charge amount by settlement currency,
 * expressed in major units. CNY and CLP aren't documented settlement
 * currencies; their exact presentment minimum depends on conversion into the
 * Stripe account's settlement currency, so Stripe remains authoritative.
 */
export const STRIPE_MIN_TOTAL: Readonly<
  Record<SupportedCurrency, number | null>
> = {
  czk: 15,
  eur: 0.5,
  usd: 0.5,
  gbp: 0.3,
  pln: 2,
  chf: 0.5,
  dkk: 2.5,
  nok: 3,
  sek: 3,
  aud: 0.5,
  cad: 0.5,
  nzd: 0.5,
  jpy: 50,
  huf: 175,
  ron: 2,
  cny: null,
  inr: 0.5,
  zar: 0.5,
  brl: 0.5,
  mxn: 10,
  ars: 0.5,
  clp: null,
};

export const CURRENCY_EXPONENT: Readonly<
  Record<SupportedCurrency, 0 | 2>
> = Object.fromEntries(
  STUDIO_COMMERCE_CURRENCIES.map((currency) => [
    currency.toLowerCase(),
    currency === "JPY" || currency === "CLP" ? 0 : 2,
  ]),
) as Record<SupportedCurrency, 0 | 2>;

export type StripeLineItemLike = {
  quantity?: number | null;
  price_data?: {
    unit_amount?: number | null;
  } | null;
};

export type StripeMinimumResult = {
  ok: boolean;
  currency: SupportedCurrency;
  totalMinor: number;
  minMinor: number | null;
  minimumSource: "configured" | "stripe";
};

export const isSupportedCurrency = (
  currency: unknown,
): currency is SupportedCurrency => {
  const normalized = String(currency).trim().toUpperCase();
  return isStudioCommerceCurrency(normalized);
};

export const normalizeCurrency = (
  currency: unknown,
): SupportedCurrency => {
  const normalized = String(currency ?? "").trim().toUpperCase();

  if (!isStudioCommerceCurrency(normalized)) {
    throw new Error(`Unsupported currency: ${String(currency)}`);
  }

  return normalized.toLowerCase() as SupportedCurrency;
};

export const normalizePrice = (value: unknown): number => {
  if (value == null) return Number.NaN;

  if (typeof value === "string") {
    return Number(value.replace(/\s/g, "").replace(",", "."));
  }

  return Number(value);
};

export const toMinorUnits = (
  priceMajor: unknown,
  currency: SupportedCurrency = DEFAULT_CURRENCY,
): number => {
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedPrice = normalizePrice(priceMajor);

  if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
    throw new Error(`Invalid price amount: ${String(priceMajor)}`);
  }

  return toCurrencyMinorUnits(
    normalizedPrice,
    normalizedCurrency.toUpperCase() as StudioCommerceCurrency,
  );
};

export const safeQty = (quantity: unknown): number => {
  const normalizedQuantity = Math.ceil(Number(quantity));

  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
    return 0;
  }

  return normalizedQuantity;
};

export const sumLineItemsMinor = (
  lineItems: StripeLineItemLike[] = [],
): number =>
  lineItems.reduce((sum, lineItem) => {
    const quantity = safeQty(lineItem.quantity);
    const unitAmount = Number(lineItem.price_data?.unit_amount || 0);
    return sum + quantity * unitAmount;
  }, 0);

export const assertStripeMinimum = (
  lineItems: StripeLineItemLike[],
  currency: unknown = DEFAULT_CURRENCY,
): StripeMinimumResult => {
  const normalizedCurrency = normalizeCurrency(currency);
  const totalMinor = sumLineItemsMinor(lineItems);
  const minimumMajor = STRIPE_MIN_TOTAL[normalizedCurrency];
  const minMinor =
    minimumMajor === null
      ? null
      : toMinorUnits(minimumMajor, normalizedCurrency);

  return {
    // For converted presentment currencies, Stripe calculates the exact
    // settlement-currency equivalent. Locally we can only require a positive
    // amount and let the provider enforce its current conversion threshold.
    ok: minMinor === null ? totalMinor > 0 : totalMinor >= minMinor,
    currency: normalizedCurrency,
    totalMinor,
    minMinor,
    minimumSource: minMinor === null ? "stripe" : "configured",
  };
};
