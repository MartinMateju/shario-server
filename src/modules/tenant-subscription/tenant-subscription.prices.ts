import type { PlatformBillingCurrency } from "@/shared/money/currency.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import type { BillingInterval } from "./tenant-subscription.types.js";

export const INTERNATIONAL_OFFER_ID = "international_2026_v1" as const;

export type ConfiguredCurrencyAmounts = Readonly<
  Record<PlatformBillingCurrency, number | null>
>;

/**
 * Fixed, tax-exclusive prices in integer minor units, never exchange rates.
 * null means pricing is awaiting approval: display unavailable and reject
 * checkout in that currency. Do not replace it with another currency's price.
 *
 * Before this offer is provisioned, replace null with approved prices in each
 * plan/interval. After provisioning, add an immutable offer version instead
 * of changing charged amounts under an existing offer ID.
 */
export const INTERNATIONAL_PRICE_AMOUNTS_MINOR = {
  starter: {
    monthly: {
      EUR: 3_900,
      USD: 4_500,
      CZK: 99_000,
      GBP: 3_500,
      CHF: 3_900,
      PLN: 16_900,
      DKK: 29_900,
      SEK: 44_900,
      NOK: 42_900,
      CAD: 6_500,
      AUD: 6_500,
    },
    yearly: {
      EUR: 39_000,
      USD: 45_000,
      CZK: 990_000,
      GBP: 35_000,
      CHF: 39_000,
      PLN: 169_000,
      DKK: 299_000,
      SEK: 449_000,
      NOK: 429_000,
      CAD: 65_000,
      AUD: 65_000,
    },
  },

  professional: {
    monthly: {
      EUR: 7_900,
      USD: 8_900,
      CZK: 199_000,
      GBP: 6_900,
      CHF: 7_500,
      PLN: 34_900,
      DKK: 59_900,
      SEK: 89_900,
      NOK: 84_900,
      CAD: 12_900,
      AUD: 12_900,
    },
    yearly: {
      EUR: 79_000,
      USD: 89_000,
      CZK: 1_990_000,
      GBP: 69_000,
      CHF: 75_000,
      PLN: 349_000,
      DKK: 599_000,
      SEK: 899_000,
      NOK: 849_000,
      CAD: 129_000,
      AUD: 129_000,
    },
  },

  studio_plus: {
    monthly: {
      EUR: 16_900,
      USD: 18_900,
      CZK: 429_000,
      GBP: 14_900,
      CHF: 15_900,
      PLN: 74_900,
      DKK: 129_900,
      SEK: 189_900,
      NOK: 179_900,
      CAD: 26_900,
      AUD: 27_900,
    },
    yearly: {
      EUR: 169_000,
      USD: 189_000,
      CZK: 4_290_000,
      GBP: 149_000,
      CHF: 159_000,
      PLN: 749_000,
      DKK: 1_299_000,
      SEK: 1_899_000,
      NOK: 1_799_000,
      CAD: 269_000,
      AUD: 279_000,
    },
  },

  enterprise: {
    monthly: {
      EUR: 31_900,
      USD: 35_900,
      CZK: 799_000,
      GBP: 27_900,
      CHF: 29_900,
      PLN: 139_900,
      DKK: 239_900,
      SEK: 359_900,
      NOK: 339_900,
      CAD: 50_900,
      AUD: 51_900,
    },
    yearly: null,
  },
} as const satisfies Readonly<
  Record<TenantPlan, Readonly<Record<BillingInterval, ConfiguredCurrencyAmounts | null>>>
>;
