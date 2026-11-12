import type Stripe from "stripe";

import {
  getPlanSelectionFromStripeLookupKey,
  getPlanSelectionFromStripePriceId,
  getStripePriceReference,
  type StripePlanSelection,
} from "./tenant-subscription.catalog.js";
import {
  getCommercialPriceSpec,
  getCommercialPriceSpecForOffer,
  getCommercialPriceCurrencies,
  getRequiredCommercialPriceAmount,
} from "./tenant-subscription.commercial.js";

export const STRIPE_CATALOG_METADATA = {
  managed: "shario_managed",
  offerId: "shario_offer_id",
  plan: "shario_plan",
  entitlementVersion: "shario_entitlement_version",
  billingInterval: "shario_billing_interval",
} as const;

export type TenantBillingStripeMode = "test" | "live";

export type StripeCatalogIssue = {
  code: string;
  message: string;
};

type CommercialPriceSpec = NonNullable<
  ReturnType<typeof getCommercialPriceSpec>
>;

const expectedLivemodeFor = (mode: TenantBillingStripeMode): boolean =>
  mode === "live";

export const getTenantBillingStripeMode = (): TenantBillingStripeMode => {
  const configured =
    process.env.STRIPE_TENANT_BILLING_MODE?.trim().toLowerCase() || "test";

  if (configured !== "test" && configured !== "live") {
    throw new Error("STRIPE_TENANT_BILLING_MODE must be exactly test or live.");
  }

  return configured;
};

export const getTenantBillingStripeKeyIssue = ({
  secretKey,
  mode = getTenantBillingStripeMode(),
}: {
  secretKey: string;
  mode?: TenantBillingStripeMode;
}): string | null => {
  const expectedPrefix = mode === "live" ? "sk_live_" : "sk_test_";

  return secretKey.startsWith(expectedPrefix)
    ? null
    : `STRIPE_KEY does not match STRIPE_TENANT_BILLING_MODE=${mode}.`;
};

export const isTenantBillingAutomaticTaxEnabled = (
  configuredValue: string | undefined = process.env
    .STRIPE_AUTOMATIC_TAX_ENABLED,
): boolean => configuredValue?.trim().toLowerCase() === "true";

export const getTenantBillingAutomaticTaxIssue = ({
  mode = getTenantBillingStripeMode(),
  automaticTaxEnabled = isTenantBillingAutomaticTaxEnabled(),
}: {
  mode?: TenantBillingStripeMode;
  automaticTaxEnabled?: boolean;
} = {}): string | null =>
  mode === "live" && !automaticTaxEnabled
    ? "Live tenant billing requires STRIPE_AUTOMATIC_TAX_ENABLED=true."
    : null;

export const assertTenantBillingAutomaticTaxReady = (input?: {
  mode?: TenantBillingStripeMode;
  automaticTaxEnabled?: boolean;
}): void => {
  const issue = getTenantBillingAutomaticTaxIssue(input);
  if (issue) throw new Error(issue);
};

export const buildStripeProductMetadata = (
  spec: CommercialPriceSpec,
): Record<string, string> => ({
  [STRIPE_CATALOG_METADATA.managed]: "true",
  [STRIPE_CATALOG_METADATA.offerId]: spec.offerId,
  [STRIPE_CATALOG_METADATA.plan]: spec.plan,
  [STRIPE_CATALOG_METADATA.entitlementVersion]: String(spec.entitlementVersion),
});

export const buildStripePriceMetadata = (
  spec: CommercialPriceSpec,
): Record<string, string> => ({
  ...buildStripeProductMetadata(spec),
  [STRIPE_CATALOG_METADATA.billingInterval]: spec.billingInterval,
});

/** Pure provisioning payload, shared by the sync command and contract tests. */
export const buildStripePriceCreateParams = (
  spec: CommercialPriceSpec,
  productId: string,
): Stripe.PriceCreateParams => ({
  active: true,
  product: productId,
  lookup_key: spec.lookupKey,
  currency: spec.defaultCurrency.toLowerCase(),
  unit_amount: getRequiredCommercialPriceAmount(spec, spec.defaultCurrency),
  currency_options: Object.fromEntries(
    getCommercialPriceCurrencies(spec)
      .filter((currency) => currency !== spec.defaultCurrency)
      .map((currency) => [currency.toLowerCase(), {
        unit_amount: getRequiredCommercialPriceAmount(spec, currency),
        tax_behavior: spec.taxBehavior,
      }]),
  ),
  recurring: {
    interval: spec.billingInterval === "yearly" ? "year" : "month",
    interval_count: 1,
    usage_type: "licensed",
  },
  tax_behavior: spec.taxBehavior,
  metadata: buildStripePriceMetadata(spec),
});

const addMismatch = (
  issues: StripeCatalogIssue[],
  code: string,
  label: string,
  actual: unknown,
  expected: unknown,
): void => {
  if (actual === expected) return;

  issues.push({
    code,
    message: `${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`,
  });
};

const getExpandedProduct = (price: Stripe.Price): Stripe.Product | null => {
  if (typeof price.product === "string") return null;
  if ("deleted" in price.product && price.product.deleted) return null;

  return price.product as Stripe.Product;
};

export const inspectStripePriceContract = ({
  price,
  spec,
  mode = getTenantBillingStripeMode(),
}: {
  price: Stripe.Price;
  spec: CommercialPriceSpec;
  mode?: TenantBillingStripeMode;
}): StripeCatalogIssue[] => {
  const issues: StripeCatalogIssue[] = [];
  const expectedLivemode = expectedLivemodeFor(mode);
  const expectedRecurringInterval =
    spec.billingInterval === "yearly" ? "year" : "month";

  addMismatch(issues, "price.active", "Price active state", price.active, true);
  addMismatch(
    issues,
    "price.livemode",
    "Price livemode",
    price.livemode,
    expectedLivemode,
  );
  addMismatch(
    issues,
    "price.lookup_key",
    "Price lookup key",
    price.lookup_key,
    spec.lookupKey,
  );
  addMismatch(issues, "price.type", "Price type", price.type, "recurring");
  addMismatch(
    issues,
    "price.billing_scheme",
    "Price billing scheme",
    price.billing_scheme,
    "per_unit",
  );
  addMismatch(
    issues,
    "price.recurring.interval",
    "Price recurring interval",
    price.recurring?.interval,
    expectedRecurringInterval,
  );
  addMismatch(
    issues,
    "price.recurring.interval_count",
    "Price recurring interval count",
    price.recurring?.interval_count,
    1,
  );
  addMismatch(
    issues,
    "price.recurring.usage_type",
    "Price recurring usage type",
    price.recurring?.usage_type,
    "licensed",
  );
  addMismatch(
    issues,
    "price.tax_behavior",
    "Price tax behavior",
    price.tax_behavior,
    spec.taxBehavior,
  );
  addMismatch(
    issues,
    "price.currency",
    "Price default currency",
    price.currency.toUpperCase(),
    spec.defaultCurrency,
  );

  for (const currency of getCommercialPriceCurrencies(spec)) {
    const currencyKey = currency.toLowerCase();
    const option = price.currency_options?.[currencyKey];
    const unitAmount =
      currency === price.currency.toUpperCase()
        ? price.unit_amount
        : option?.unit_amount;
    const effectiveTaxBehavior =
      currency === price.currency.toUpperCase()
        ? price.tax_behavior
        : (option?.tax_behavior ?? price.tax_behavior);

    addMismatch(
      issues,
      `price.amount.${currency}`,
      `${currency} unit amount`,
      unitAmount,
      spec.amounts[currency],
    );
    addMismatch(
      issues,
      `price.tax_behavior.${currency}`,
      `${currency} tax behavior`,
      effectiveTaxBehavior,
      spec.taxBehavior,
    );
  }

  const expectedPriceMetadata = buildStripePriceMetadata(spec);

  for (const [key, expected] of Object.entries(expectedPriceMetadata)) {
    addMismatch(
      issues,
      `price.metadata.${key}`,
      `Price metadata ${key}`,
      price.metadata[key],
      expected,
    );
  }

  const product = getExpandedProduct(price);

  if (!product) {
    issues.push({
      code: "price.product",
      message: "Price product is deleted or was not expanded.",
    });
    return issues;
  }

  addMismatch(
    issues,
    "product.active",
    "Product active state",
    product.active,
    true,
  );
  addMismatch(
    issues,
    "product.livemode",
    "Product livemode",
    product.livemode,
    expectedLivemode,
  );
  addMismatch(
    issues,
    "product.name",
    "Product name",
    product.name,
    `shario.io ${spec.displayName}`,
  );

  const expectedProductMetadata = buildStripeProductMetadata(spec);

  for (const [key, expected] of Object.entries(expectedProductMetadata)) {
    addMismatch(
      issues,
      `product.metadata.${key}`,
      `Product metadata ${key}`,
      product.metadata[key],
      expected,
    );
  }

  return issues;
};

export const assertStripePriceContract = (input: {
  price: Stripe.Price;
  spec: CommercialPriceSpec;
  mode?: TenantBillingStripeMode;
}): void => {
  const issues = inspectStripePriceContract(input);

  if (!issues.length) return;

  throw new Error(
    `Stripe Price ${input.price.id} violates the Shario commercial contract: ${issues
      .map((issue) => issue.message)
      .join(" ")}`,
  );
};

const selectionsMatch = (
  left: StripePlanSelection,
  right: StripePlanSelection,
): boolean =>
  left.plan === right.plan &&
  left.planVersion === right.planVersion &&
  left.offerId === right.offerId &&
  left.billingInterval === right.billingInterval;

const getStripeSubscriptionSelection = (
  price: Stripe.Price,
): StripePlanSelection => {
  const fromPriceId = getPlanSelectionFromStripePriceId(price.id);
  const fromLookupKey = price.lookup_key
    ? getPlanSelectionFromStripeLookupKey(price.lookup_key)
    : null;

  if (
    fromPriceId &&
    fromLookupKey &&
    !selectionsMatch(fromPriceId, fromLookupKey)
  ) {
    throw new Error(
      `Stripe Price ${price.id} maps to conflicting Shario plan selections.`,
    );
  }

  const selection = fromPriceId ?? fromLookupKey;

  if (!selection) {
    throw new Error(
      `Stripe Price ${price.id} is not configured in the Shario plan catalogue.`,
    );
  }

  return selection;
};

const assertMetadataValue = (
  metadata: Stripe.Metadata,
  key: string,
  expected: string,
  subject: string,
  allowMissing = false,
): void => {
  if (allowMissing && metadata[key] === undefined) return;
  if (metadata[key] === expected) return;

  throw new Error(
    `${subject} metadata ${key} is ${JSON.stringify(metadata[key])}; expected ${JSON.stringify(expected)}.`,
  );
};

/**
 * Webhook entitlement projection must never trust metadata alone. The Price
 * first has to resolve to an immutable Shario catalogue selection, then both
 * subscription metadata and the v2 commercial Stripe contract must agree.
 */
export const assertStripeSubscriptionContract = ({
  stripeSubscription,
  mode = getTenantBillingStripeMode(),
}: {
  stripeSubscription: Stripe.Subscription;
  mode?: TenantBillingStripeMode;
}): StripePlanSelection => {
  if (stripeSubscription.items.data.length !== 1) {
    throw new Error(
      `Stripe subscription ${stripeSubscription.id} must contain exactly one Shario plan item.`,
    );
  }

  const item = stripeSubscription.items.data[0];
  const price = item?.price;

  if (!price || item.quantity !== 1) {
    throw new Error(
      `Stripe subscription ${stripeSubscription.id} must contain quantity 1 of a configured Shario Price.`,
    );
  }

  const selection = getStripeSubscriptionSelection(price);
  const reference = getStripePriceReference(
    selection.plan,
    selection.billingInterval,
    selection.planVersion,
    selection.offerId,
  );
  const spec = selection.offerId
    ? getCommercialPriceSpecForOffer(
        selection.offerId,
        selection.plan,
        selection.billingInterval,
        selection.planVersion,
      )
    : null;

  if (!reference) {
    throw new Error(
      `Stripe Price ${price.id} does not have a canonical Shario reference.`,
    );
  }

  if (
    spec
      ? price.lookup_key !== reference.lookupKey
      : Boolean(price.lookup_key && price.lookup_key !== reference.lookupKey)
  ) {
    throw new Error(
      `Stripe Price ${price.id} does not use the canonical lookup key for its Shario plan.`,
    );
  }

  const metadata = stripeSubscription.metadata;
  const allowMissingLegacyMetadata =
    selection.planVersion === 1 && selection.offerId === null;

  assertMetadataValue(
    metadata,
    "plan",
    selection.plan,
    "Subscription",
    allowMissingLegacyMetadata,
  );
  assertMetadataValue(
    metadata,
    "planVersion",
    String(selection.planVersion),
    "Subscription",
    allowMissingLegacyMetadata,
  );
  assertMetadataValue(
    metadata,
    "billingInterval",
    selection.billingInterval,
    "Subscription",
    allowMissingLegacyMetadata,
  );
  assertMetadataValue(
    metadata,
    "priceLookupKey",
    reference.lookupKey,
    "Subscription",
    allowMissingLegacyMetadata,
  );

  if (allowMissingLegacyMetadata && metadata.offerId !== undefined) {
    throw new Error(
      `Subscription metadata offerId is ${JSON.stringify(metadata.offerId)}; expected it to be absent for a legacy V1 Price.`,
    );
  }

  const expectedRecurringInterval =
    selection.billingInterval === "yearly" ? "year" : "month";

  if (price.recurring?.interval !== expectedRecurringInterval) {
    throw new Error(
      `Stripe Price ${price.id} recurring interval does not match ${selection.billingInterval}.`,
    );
  }

  if (price.livemode !== expectedLivemodeFor(mode)) {
    throw new Error(
      `Stripe Price ${price.id} livemode does not match tenant billing mode ${mode}.`,
    );
  }

  if (spec) {
    assertMetadataValue(metadata, "offerId", spec.offerId, "Subscription");
    assertStripePriceContract({ price, spec, mode });
  }

  return selection;
};
