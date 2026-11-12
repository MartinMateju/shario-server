import { normalizeRolloutEligibleAppLocale } from "@/shared/i18n/locales.js";
import {
  normalizePlatformBillingCurrency,
  type PlatformBillingCurrency,
} from "@/shared/money/currency.js";

// Region hints are used only while creating a new tenant. Never run this
// resolver on login or against an existing tenant's saved settings.
const EURO_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
  "AD", "MC", "SM", "VA", "ME", "XK", "AX", "BL", "GF", "GP", "MF",
  "MQ", "PM", "RE", "TF", "YT",
]);

const COUNTRY_CURRENCIES: Readonly<Record<string, PlatformBillingCurrency>> = {
  US: "USD", CZ: "CZK", GB: "GBP", GG: "GBP", IM: "GBP", JE: "GBP",
  CH: "CHF", LI: "CHF", PL: "PLN", DK: "DKK", GL: "DKK", FO: "DKK",
  SE: "SEK", NO: "NOK", SJ: "NOK", BV: "NOK", CA: "CAD", AU: "AUD",
  CC: "AUD", CX: "AUD", HM: "AUD", KI: "AUD", NR: "AUD", NF: "AUD", TV: "AUD",
  AS: "USD", BQ: "USD", EC: "USD", FM: "USD", GU: "USD", IO: "USD",
  MH: "USD", MP: "USD", PA: "USD", PR: "USD", PW: "USD", SV: "USD",
  TC: "USD", TL: "USD", UM: "USD", VG: "USD", VI: "USD",
};

export const getRegistrationCurrencyForCountry = (
  country: string | undefined,
): PlatformBillingCurrency => {
  const region = country?.trim().toUpperCase() ?? "";
  return EURO_COUNTRIES.has(region) ? "EUR" : COUNTRY_CURRENCIES[region] ?? "USD";
};

export type RegistrationPreferences = {
  locale?: string;
  country?: string;
  currency?: PlatformBillingCurrency;
  timezone?: string;
};

export const resolveRegistrationPreferences = (input: RegistrationPreferences) => {
  const locale = normalizeRolloutEligibleAppLocale(input.locale) ?? "en";
  const country = input.country?.trim().toUpperCase() ?? "";
  return {
    locale,
    country,
    currency: input.currency
      ? normalizePlatformBillingCurrency(input.currency)
      : getRegistrationCurrencyForCountry(country),
    timezone: input.timezone?.trim() || "UTC",
  };
};
