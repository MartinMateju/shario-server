import "dotenv/config";

import type Stripe from "stripe";

import { getCurrentPlanVersion } from "@/modules/tenants/tenant.plan.js";

import { BILLING_INTERVAL } from "../tenant-subscription.constants.js";
import {
  getCommercialPriceSpec,
  getCommercialPriceCurrencies,
} from "../tenant-subscription.commercial.js";
import { SELF_SERVE_PLANS } from "../tenant-subscription.catalog.js";
import {
  assertStripePriceContract,
  assertTenantBillingAutomaticTaxReady,
  buildStripePriceCreateParams,
  buildStripeProductMetadata,
  getTenantBillingStripeMode,
  inspectStripePriceContract,
  STRIPE_CATALOG_METADATA,
  type TenantBillingStripeMode,
} from "../tenant-subscription.stripe-contract.js";
import { getTenantBillingStripe } from "../services/tenant-subscription.stripe.service.js";

type Operation = "plan" | "verify" | "apply";
type CommercialPriceSpec = NonNullable<
  ReturnType<typeof getCommercialPriceSpec>
>;

const args = new Set(process.argv.slice(2));
const valueArg = (prefix: string): string | null => {
  const match = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return match?.slice(prefix.length) ?? null;
};

const getOperation = (): Operation => {
  const requested = [args.has("--verify"), args.has("--apply")].filter(
    Boolean,
  ).length;

  if (requested > 1) {
    throw new Error("Choose only one of --verify or --apply.");
  }

  if (args.has("--apply")) return "apply";
  if (args.has("--verify")) return "verify";
  return "plan";
};

const operation = getOperation();
const mode: TenantBillingStripeMode = args.has("--live") ? "live" : "test";

const assertModeGuard = (): void => {
  const configuredMode = getTenantBillingStripeMode();

  if (configuredMode !== mode) {
    throw new Error(
      `Pass --live only with STRIPE_TENANT_BILLING_MODE=live; current mode is ${configuredMode}.`,
    );
  }

  assertTenantBillingAutomaticTaxReady({ mode });

  if (operation === "apply" && mode === "live") {
    const expectedOfferId = getCommercialPriceSpecs()[0]?.offerId;
    const confirmation = valueArg("--confirm-live=");

    if (!expectedOfferId || confirmation !== expectedOfferId) {
      throw new Error(
        `Live writes require --confirm-live=${expectedOfferId ?? "<offer-id>"}.`,
      );
    }
  }
};

const getCommercialPriceSpecs = (): CommercialPriceSpec[] => {
  const specs = SELF_SERVE_PLANS.flatMap((plan) => {
    const planVersion = getCurrentPlanVersion(plan);

    return Object.values(BILLING_INTERVAL).map((billingInterval) => {
      const spec = getCommercialPriceSpec(plan, billingInterval, planVersion);

      if (!spec) {
        throw new Error(
          `Missing commercial Price contract for ${plan} ${billingInterval} v${planVersion}.`,
        );
      }

      return spec;
    });
  });

  if (specs.length !== 6) {
    throw new Error(
      `Expected six self-serve Price contracts; found ${specs.length}.`,
    );
  }

  return specs;
};

const findPrice = async (
  stripe: Stripe,
  lookupKey: string,
): Promise<Stripe.Price | null> => {
  const result = await stripe.prices.list({
    lookup_keys: [lookupKey],
    limit: 10,
    expand: ["data.currency_options", "data.product"],
  });

  if (result.data.length > 1) {
    throw new Error(
      `Multiple active Stripe Prices use lookup key ${lookupKey}.`,
    );
  }

  return result.data[0] ?? null;
};

const findManagedProduct = async (
  stripe: Stripe,
  spec: CommercialPriceSpec,
): Promise<Stripe.Product | null> => {
  const matches: Stripe.Product[] = [];

  await stripe.products.list({ limit: 100 }).autoPagingEach((product) => {
    if (
      product.metadata[STRIPE_CATALOG_METADATA.managed] === "true" &&
      product.metadata[STRIPE_CATALOG_METADATA.offerId] === spec.offerId &&
      product.metadata[STRIPE_CATALOG_METADATA.plan] === spec.plan &&
      product.metadata[STRIPE_CATALOG_METADATA.entitlementVersion] ===
        String(spec.entitlementVersion)
    ) {
      matches.push(product);
    }

    // A second match is already a hard error; stopping here still scans an
    // unbounded number of pages until a duplicate is actually found.
    return matches.length < 2;
  });

  if (matches.length > 1) {
    throw new Error(
      `Multiple managed Stripe Products match ${spec.offerId}/${spec.plan}.`,
    );
  }

  return matches[0] ?? null;
};

const printAction = (
  action: "create" | "ok" | "error",
  subject: string,
  detail: string,
): void => {
  process.stdout.write(`[${action.toUpperCase()}] ${subject}: ${detail}\n`);
};

const reconcileProduct = async ({
  stripe,
  spec,
  product: existing,
}: {
  stripe: Stripe;
  spec: CommercialPriceSpec;
  product: Stripe.Product | null;
}): Promise<Stripe.Product | null> => {
  const expectedName = `shario.io ${spec.displayName}`;
  const expectedMetadata = buildStripeProductMetadata(spec);

  if (!existing) {
    printAction("create", "Product", `${expectedName} (${spec.offerId})`);

    if (operation !== "apply") return null;

    return stripe.products.create(
      {
        active: true,
        name: expectedName,
        description: `${spec.displayName} — ${spec.offerId}`,
        metadata: expectedMetadata,
      },
      { idempotencyKey: `shario-product:${spec.offerId}:${spec.plan}` },
    );
  }

  if (existing.livemode !== (mode === "live")) {
    throw new Error(
      `Product ${existing.id} livemode does not match requested ${mode} mode.`,
    );
  }

  const issues = [
    ...(!existing.active ? ["inactive"] : []),
    ...(existing.name !== expectedName
      ? [`name is ${JSON.stringify(existing.name)}`]
      : []),
    ...Object.entries(expectedMetadata)
      .filter(([key, value]) => existing.metadata[key] !== value)
      .map(
        ([key, value]) =>
          `metadata ${key} is ${JSON.stringify(existing.metadata[key])}; expected ${JSON.stringify(value)}`,
      ),
  ];

  if (issues.length) {
    throw new Error(
      `Managed Product ${existing.id} has drift and will not be edited: ${issues.join("; ")}. Create a new commercial offer instead.`,
    );
  }

  printAction("ok", "Product", `${existing.id} ${expectedName}`);
  return existing;
};

const createPrice = async ({
  stripe,
  product,
  spec,
}: {
  stripe: Stripe;
  product: Stripe.Product;
  spec: CommercialPriceSpec;
}): Promise<Stripe.Price> => {
  return stripe.prices.create(
    buildStripePriceCreateParams(spec, product.id),
    {
      idempotencyKey: `shario-price:${spec.offerId}:${spec.plan}:${spec.billingInterval}`,
    },
  );
};

const reconcileExistingPrice = async ({
  price,
  spec,
}: {
  price: Stripe.Price;
  spec: CommercialPriceSpec;
}): Promise<Stripe.Price> => {
  const issues = inspectStripePriceContract({ price, spec, mode });

  if (!issues.length) {
    printAction("ok", "Price", `${price.id} ${spec.lookupKey}`);
    return price;
  }

  throw new Error(
    `Price ${price.id} has contract drift and will not be edited: ${issues
      .map((issue) => issue.message)
      .join(" ")} Create a new commercial offer instead.`,
  );
};

const reconcileSpec = async (
  stripe: Stripe,
  spec: CommercialPriceSpec,
): Promise<{ spec: CommercialPriceSpec; price: Stripe.Price | null }> => {
  const existingPrice = await findPrice(stripe, spec.lookupKey);

  if (existingPrice) {
    return {
      spec,
      price: await reconcileExistingPrice({
        price: existingPrice,
        spec,
      }),
    };
  }

  if (operation === "verify") {
    throw new Error(`Missing active Stripe Price ${spec.lookupKey}.`);
  }

  const existingProduct = await findManagedProduct(stripe, spec);
  const product = await reconcileProduct({
    stripe,
    spec,
    product: existingProduct,
  });
  printAction(
    "create",
    "Price",
    `${spec.lookupKey} (${getCommercialPriceCurrencies(spec).map(
      (currency) => `${currency} ${spec.amounts[currency]}`,
    ).join(", ")})`,
  );

  if (operation !== "apply" || !product) return { spec, price: null };

  const created = await createPrice({ stripe, product, spec });
  const price = await stripe.prices.retrieve(created.id, {
    expand: ["currency_options", "product"],
  });
  assertStripePriceContract({ price, spec, mode });
  return { spec, price };
};

const main = async (): Promise<void> => {
  assertModeGuard();
  const specs = getCommercialPriceSpecs();
  const offerIds = new Set(specs.map((spec) => spec.offerId));

  if (offerIds.size !== 1) {
    throw new Error("The current self-serve Prices must belong to one offer.");
  }

  process.stdout.write(
    `Shario Stripe catalogue ${operation} (${mode} mode, offer ${specs[0].offerId})\n`,
  );

  const stripe = getTenantBillingStripe();
  const results = [];

  for (const spec of specs) {
    results.push(await reconcileSpec(stripe, spec));
  }

  if (operation === "plan") {
    process.stdout.write(
      "\nDry run only. Re-run with --apply to write test-mode objects.\n",
    );
    return;
  }

  process.stdout.write("\nVersioned Price IDs for this environment:\n");

  for (const { spec, price } of results) {
    if (!price) continue;
    const envKey = `STRIPE_${spec.offerId.toUpperCase()}_${spec.plan.toUpperCase()}_${spec.billingInterval.toUpperCase()}_PRICE_ID`;
    process.stdout.write(`${envKey}=${price.id}\n`);
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Stripe tenant catalogue failed: ${message}\n`);
  process.exitCode = 1;
});
