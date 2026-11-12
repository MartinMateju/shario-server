import {
  DEFAULT_PLATFORM_BILLING_CURRENCY,
  PLATFORM_BILLING_CURRENCIES,
} from "@/shared/money/currency.js";
import {
  getCurrentCommercialOffer,
  type CommercialRecurringPrice,
} from "./tenant-subscription.commercial.js";

/** Public projection of code-owned amounts. Never calls Stripe or exposes IDs. */
export const getPublicSubscriptionCatalog = () => {
  const offer = getCurrentCommercialOffer();
  const prices = (price: CommercialRecurringPrice) => Object.fromEntries(
    PLATFORM_BILLING_CURRENCIES.map((currency) => {
      const amountMinor = price.amounts?.[currency] ?? null;
      return [currency, {
        amountMinor,
        available: amountMinor !== null && offer.newSaleCurrencies.includes(currency),
        type: price.type,
      }];
    }),
  );

  return {
    offerId: offer.id,
    currencies: [...PLATFORM_BILLING_CURRENCIES],
    availableCurrencies: [...offer.newSaleCurrencies],
    defaultCurrency: DEFAULT_PLATFORM_BILLING_CURRENCY,
    annualSavingsMonths: offer.annualSavingsMonths,
    plans: Object.values(offer.plans).map((plan) => ({
      id: plan.plan,
      displayName: plan.displayName,
      selfServe: plan.selfServe,
      saleMode: plan.saleMode,
      monthly: prices(plan.recurring.monthly),
      yearly: prices(plan.recurring.yearly),
      onboarding: plan.onboarding ? prices(plan.onboarding) : null,
    })),
  };
};
