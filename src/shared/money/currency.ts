/**
 * ISO 4217 currencies supported by studio commerce.
 *
 * Keep this list deliberately explicit. A currency being supported here means
 * that prices can be stored and sent to payment providers safely; it does not
 * imply that every Stripe payment method is available for every tenant.
 */
export const STUDIO_COMMERCE_CURRENCIES = [
  "CZK",
  "EUR",
  "USD",
  "GBP",
  "PLN",
  "CHF",
  "DKK",
  "NOK",
  "SEK",
  "AUD",
  "CAD",
  "NZD",
  "JPY",
  "HUF",
  "RON",
  "CNY",
  "INR",
  "ZAR",
  "BRL",
  "MXN",
  "ARS",
  "CLP",
] as const;

export type StudioCommerceCurrency =
  (typeof STUDIO_COMMERCE_CURRENCIES)[number];

/** Currencies in which a tenant can pay Shario's own subscription invoice. */
export const PLATFORM_BILLING_CURRENCIES = [
  "EUR",
  "USD",
  "CZK",
  "GBP",
  "CHF",
  "PLN",
  "DKK",
  "SEK",
  "NOK",
  "CAD",
  "AUD",
] as const;

export type PlatformBillingCurrency =
  (typeof PLATFORM_BILLING_CURRENCIES)[number];

export const DEFAULT_STUDIO_COMMERCE_CURRENCY: StudioCommerceCurrency = "CZK";
export const DEFAULT_PLATFORM_BILLING_CURRENCY: PlatformBillingCurrency = "USD";

/**
 * Stripe charge amounts use ISO minor units. JPY and CLP are the zero-decimal
 * currencies in Shario's supported commerce set. HUF still uses two decimal
 * places for charges (Stripe's special HUF payout rule is unrelated here).
 */
export const CURRENCY_EXPONENT: Readonly<
  Record<StudioCommerceCurrency, 0 | 2>
> = {
  CZK: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  PLN: 2,
  CHF: 2,
  DKK: 2,
  NOK: 2,
  SEK: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  JPY: 0,
  HUF: 2,
  RON: 2,
  CNY: 2,
  INR: 2,
  ZAR: 2,
  BRL: 2,
  MXN: 2,
  ARS: 2,
  CLP: 0,
};

export const isStudioCommerceCurrency = (
  value: unknown,
): value is StudioCommerceCurrency =>
  STUDIO_COMMERCE_CURRENCIES.includes(
    String(value).trim().toUpperCase() as StudioCommerceCurrency,
  );

export const isPlatformBillingCurrency = (
  value: unknown,
): value is PlatformBillingCurrency =>
  PLATFORM_BILLING_CURRENCIES.includes(
    String(value).trim().toUpperCase() as PlatformBillingCurrency,
  );

export const normalizeStudioCommerceCurrency = (
  value: unknown,
): StudioCommerceCurrency => {
  const currency = String(value ?? "").trim().toUpperCase();

  if (!isStudioCommerceCurrency(currency)) {
    throw new Error(`Unsupported studio commerce currency: ${String(value)}`);
  }

  return currency;
};

export const normalizePlatformBillingCurrency = (
  value: unknown,
): PlatformBillingCurrency => {
  const currency = String(value ?? "").trim().toUpperCase();

  if (!isPlatformBillingCurrency(currency)) {
    throw new Error(`Unsupported platform billing currency: ${String(value)}`);
  }

  return currency;
};

export const getCurrencyExponent = (
  currency: StudioCommerceCurrency,
): 0 | 2 => CURRENCY_EXPONENT[currency];

export const toCurrencyMinorUnits = (
  amountMajor: number,
  currency: StudioCommerceCurrency,
): number => {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new Error(`Invalid money amount: ${String(amountMajor)}`);
  }

  const scaled = amountMajor * 10 ** getCurrencyExponent(currency);
  const rounded = Math.round(scaled);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;

  if (Math.abs(scaled - rounded) > tolerance) {
    throw new Error(
      `${currency} amount has more decimal places than the currency supports.`,
    );
  }

  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`Money amount exceeds the safe integer range: ${amountMajor}`);
  }

  return rounded;
};

export const fromCurrencyMinorUnits = (
  amountMinor: number,
  currency: StudioCommerceCurrency,
): number => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`Invalid minor-unit amount: ${String(amountMinor)}`);
  }

  return amountMinor / 10 ** getCurrencyExponent(currency);
};
