import "dotenv/config";

import mongoose from "mongoose";

import { Cart } from "@/modules/cart/cart.model.js";
import { CouponOrder } from "@/modules/coupon/coupon.model.js";
import Event from "@/modules/event/event.model.js";
import {
  InventoryItem,
  InventoryMovement,
} from "@/modules/inventory/inventory.model.js";
import { MembershipPlan } from "@/modules/membership/membership-plan.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import { Product } from "@/modules/product/product.model.js";
import SupplyOrder from "@/modules/supplies/supply-order.model.js";
import TenantSubscriptionModel from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import connectDB from "@/infrastructure/database/connect-db.js";
import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  isStudioCommerceCurrency,
} from "@/shared/money/currency.js";

type RawTenant = {
  _id: mongoose.Types.ObjectId;
  slug?: string;
  planVersion?: number;
  settings?: { currency?: unknown };
};

const APPLY_FLAG = "--apply";
const shouldApply = process.argv.includes(APPLY_FLAG);
const sampleLimit = 100;

type MongoFilter = mongoose.mongo.Filter<Record<string, unknown>>;

const missingString = (field: string): MongoFilter => ({
  $or: [
    { [field]: { $exists: false } },
    { [field]: null },
    { [field]: "" },
  ],
});

const sampleIds = async (
  collection: mongoose.mongo.Collection,
  filter: MongoFilter,
): Promise<string[]> => {
  const documents = await collection
    .find(filter, { projection: { _id: 1 } })
    .limit(sampleLimit)
    .toArray();

  return documents.map((document) => String(document._id));
};

const run = async (): Promise<void> => {
  await connectDB();

  const tenants = (await TenantModel.collection
    .find({}, { projection: { slug: 1, planVersion: 1, settings: 1 } })
    .toArray()) as RawTenant[];

  const automatic = {
    tenantsPlanVersion: 0,
    tenantsCurrency: 0,
    productsCurrency: 0,
    membershipPlansCurrency: 0,
    creditLedgersCurrency: 0,
    creditTransactionsCurrency: 0,
    trialPlanVersion: 0,
  };
  const invalidTenantCurrencies: Array<{
    id: string;
    slug?: string;
    currency: unknown;
  }> = [];

  for (const tenant of tenants) {
    const tenantId = tenant._id;

    if (!Number.isInteger(tenant.planVersion) || Number(tenant.planVersion) < 1) {
      automatic.tenantsPlanVersion += 1;

      if (shouldApply) {
        await TenantModel.collection.updateOne(
          { _id: tenantId },
          { $set: { planVersion: 1 } },
        );
      }
    }

    const rawCurrency = tenant.settings?.currency;
    const isMissingCurrency =
      rawCurrency === undefined ||
      rawCurrency === null ||
      String(rawCurrency).trim() === "";
    const currency = isMissingCurrency
      ? DEFAULT_STUDIO_COMMERCE_CURRENCY
      : String(rawCurrency).trim().toUpperCase();

    if (!isStudioCommerceCurrency(currency)) {
      invalidTenantCurrencies.push({
        id: String(tenantId),
        slug: tenant.slug,
        currency: rawCurrency,
      });
      continue;
    }

    if (isMissingCurrency) {
      automatic.tenantsCurrency += 1;

      if (shouldApply) {
        await TenantModel.collection.updateOne(
          { _id: tenantId },
          { $set: { "settings.currency": currency } },
        );
      }
    }

    const productFilter = {
      tenant: tenantId,
      ...missingString("currency"),
    };
    const membershipFilter = {
      tenant: tenantId,
      ...missingString("currency"),
    };
    const ledgerFilter = {
      tenant: tenantId,
      ...missingString("currency"),
    };
    const transactionFilter = {
      tenant: tenantId,
      transactions: {
        $elemMatch: missingString("currency"),
      },
    };

    const [products, memberships, ledgers, transactionLedgers] =
      await Promise.all([
        Product.collection.countDocuments(productFilter),
        MembershipPlan.collection.countDocuments(membershipFilter),
        MoneyCredit.collection.countDocuments(ledgerFilter),
        MoneyCredit.collection.countDocuments(transactionFilter),
      ]);

    automatic.productsCurrency += products;
    automatic.membershipPlansCurrency += memberships;
    automatic.creditLedgersCurrency += ledgers;
    automatic.creditTransactionsCurrency += transactionLedgers;

    if (!shouldApply) {
      continue;
    }

    await Promise.all([
      Product.collection.updateMany(productFilter, {
        $set: { currency },
      }),
      MembershipPlan.collection.updateMany(membershipFilter, {
        $set: { currency },
      }),
      MoneyCredit.collection.updateMany(ledgerFilter, {
        $set: { currency },
      }),
      MoneyCredit.collection.updateMany(transactionFilter, [
        {
          $set: {
            transactions: {
              $map: {
                input: { $ifNull: ["$transactions", []] },
                as: "transaction",
                in: {
                  $mergeObjects: [
                    "$$transaction",
                    {
                      currency: {
                        $cond: [
                          {
                            $or: [
                              {
                                $eq: [
                                  { $type: "$$transaction.currency" },
                                  "missing",
                                ],
                              },
                              { $eq: ["$$transaction.currency", null] },
                              { $eq: ["$$transaction.currency", ""] },
                            ],
                          },
                          currency,
                          "$$transaction.currency",
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ]),
    ]);
  }

  const missingTrialPlanVersion = {
    $or: [
      { trialPlanVersion: { $exists: false } },
      { trialPlanVersion: null },
      { trialPlanVersion: { $lt: 1 } },
    ],
  };
  automatic.trialPlanVersion =
    await TenantSubscriptionModel.collection.countDocuments(
      missingTrialPlanVersion,
    );

  if (shouldApply && automatic.trialPlanVersion > 0) {
    await TenantSubscriptionModel.collection.updateMany(
      missingTrialPlanVersion,
      { $set: { trialPlanVersion: 1 } },
    );
  }

  const cartManualFilter = {
    $or: [
      { currency: { $exists: false } },
      { currency: null },
      { expectedAmountMinor: { $exists: false } },
      { expectedAmountMinor: null },
    ],
  };
  const orderManualFilter = {
    $or: [
      { currency: { $exists: false } },
      { currency: null },
      { expectedAmountMinor: { $exists: false } },
      { expectedAmountMinor: null },
      { paidAmountMinor: { $exists: false } },
    ],
  };
  const activeSubscriptionManualFilter = {
    "stripe.subscriptionId": { $exists: true, $nin: [null, ""] },
    $or: [
      { billingCurrency: { $exists: false } },
      { billingCurrency: null },
      { planVersion: { $exists: false } },
      { planVersion: null },
      { "stripe.priceLookupKey": { $exists: false } },
      { "stripe.priceLookupKey": null },
    ],
  };
  const couponOrderManualFilter = missingString("currencySnapshot");
  const legacyEventCurrencyFilter = {
    $and: [
      missingString("currency"),
      {
        $or: [
          { priceEstimate: { $ne: 0 } },
          { finalPrice: { $ne: 0 } },
          { depositPaid: { $ne: 0 } },
        ],
      },
    ],
  };
  const legacySupplyOrderCurrencyFilter = {
    $and: [
      missingString("currency"),
      {
        $or: [{ price: { $ne: 0 } }, { depositPaid: { $ne: 0 } }],
      },
    ],
  };
  const legacyInventoryItemCurrencyFilter = {
    $and: [
      missingString("currency"),
      { averageUnitCostWithoutVat: { $ne: 0 } },
    ],
  };
  const legacyInventoryMovementCurrencyFilter = {
    $and: [
      missingString("currency"),
      {
        $or: [
          { unitCostWithoutVat: { $ne: 0 } },
          { totalWithoutVat: { $ne: 0 } },
          { totalWithVat: { $ne: 0 } },
        ],
      },
    ],
  };

  const [
    cartCount,
    orderCount,
    subscriptionCount,
    couponOrderCount,
    eventCount,
    supplyOrderCount,
    inventoryItemCount,
    inventoryMovementCount,
  ] = await Promise.all([
      Cart.collection.countDocuments(cartManualFilter),
      Order.collection.countDocuments(orderManualFilter),
      TenantSubscriptionModel.collection.countDocuments(
        activeSubscriptionManualFilter,
      ),
      CouponOrder.collection.countDocuments(couponOrderManualFilter),
      Event.collection.countDocuments(legacyEventCurrencyFilter),
      SupplyOrder.collection.countDocuments(legacySupplyOrderCurrencyFilter),
      InventoryItem.collection.countDocuments(legacyInventoryItemCurrencyFilter),
      InventoryMovement.collection.countDocuments(
        legacyInventoryMovementCurrencyFilter,
      ),
  ]);

  const manualReview = {
    invalidTenantCurrencies,
    cartsMissingPaymentSnapshot: {
      count: cartCount,
      sampleIds: await sampleIds(Cart.collection, cartManualFilter),
    },
    ordersMissingPaymentSnapshot: {
      count: orderCount,
      sampleIds: await sampleIds(Order.collection, orderManualFilter),
    },
    subscriptionsRequiringStripeSync: {
      count: subscriptionCount,
      sampleIds: await sampleIds(
        TenantSubscriptionModel.collection,
        activeSubscriptionManualFilter,
      ),
    },
    couponOrdersMissingCurrencySnapshot: {
      count: couponOrderCount,
      sampleIds: await sampleIds(
        CouponOrder.collection,
        couponOrderManualFilter,
      ),
    },
    pricedEventsMissingCurrencySnapshot: {
      count: eventCount,
      sampleIds: await sampleIds(Event.collection, legacyEventCurrencyFilter),
    },
    pricedSupplyOrdersMissingCurrencySnapshot: {
      count: supplyOrderCount,
      sampleIds: await sampleIds(
        SupplyOrder.collection,
        legacySupplyOrderCurrencyFilter,
      ),
    },
    pricedInventoryItemsMissingCurrencySnapshot: {
      count: inventoryItemCount,
      sampleIds: await sampleIds(
        InventoryItem.collection,
        legacyInventoryItemCurrencyFilter,
      ),
    },
    pricedInventoryMovementsMissingCurrencySnapshot: {
      count: inventoryMovementCount,
      sampleIds: await sampleIds(
        InventoryMovement.collection,
        legacyInventoryMovementCurrencyFilter,
      ),
    },
  };

  console.log(
    JSON.stringify(
      {
        mode: shouldApply ? "apply" : "dry-run",
        automatic,
        manualReview,
        sampleLimit,
      },
      null,
      2,
    ),
  );
};

try {
  await run();
} catch (error) {
  console.error("Currency foundation migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
