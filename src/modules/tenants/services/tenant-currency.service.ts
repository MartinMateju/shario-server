import type { ClientSession } from "mongoose";

import { Cart } from "@/modules/cart/cart.model.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import Event from "@/modules/event/event.model.js";
import {
  InventoryItem,
  InventoryMovement,
} from "@/modules/inventory/inventory.model.js";
import { MembershipPlan } from "@/modules/membership/membership-plan.model.js";
import UserMembership from "@/modules/membership/user-membership.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import { Product } from "@/modules/product/product.model.js";
import SupplyOrder from "@/modules/supplies/supply-order.model.js";
import User from "@/modules/user/user.model.js";
import {
  normalizeStudioCommerceCurrency,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { conflict } from "@/shared/http/httpErrors.js";

type CurrencyChangeOptions = {
  session?: ClientSession | null;
};

/**
 * A workspace currency is the denomination of all studio-side prices,
 * balances and historical payment snapshots. Once monetary data exists it is
 * an accounting migration, not a settings edit.
 */
export const assertTenantOperationalCurrencyCanChange = async ({
  tenantId,
  currentCurrency,
  requestedCurrency,
  session = null,
}: {
  tenantId: string;
  currentCurrency: unknown;
  requestedCurrency: unknown;
} & CurrencyChangeOptions): Promise<StudioCommerceCurrency> => {
  const current = normalizeStudioCommerceCurrency(currentCurrency);
  const requested = normalizeStudioCommerceCurrency(requestedCurrency);

  if (current === requested) {
    return requested;
  }

  const queries = [
    Product.exists({ tenant: tenantId }),
    MembershipPlan.exists({ tenant: tenantId }),
    UserMembership.exists({ tenant: tenantId }),
    Cart.exists({ tenant: tenantId }),
    Order.exists({ tenant: tenantId }),
    Coupon.exists({ tenant: tenantId }),
    CouponOrder.exists({ tenant: tenantId }),
    MoneyCredit.exists({
      tenant: tenantId,
      $or: [
        { balance: { $ne: 0 } },
        { "transactions.0": { $exists: true } },
      ],
    }),
    User.exists({
      tenant: tenantId,
      $or: [
        { moneyCredits: { $ne: 0 } },
        { membershipCredits: { $ne: 0 } },
      ],
    }),
    Event.exists({
      tenant: tenantId,
      $or: [
        { priceEstimate: { $ne: 0 } },
        { finalPrice: { $ne: 0 } },
        { depositPaid: { $ne: 0 } },
      ],
    }),
    SupplyOrder.exists({
      tenant: tenantId,
      $or: [{ price: { $ne: 0 } }, { depositPaid: { $ne: 0 } }],
    }),
    InventoryItem.exists({
      tenant: tenantId,
      averageUnitCostWithoutVat: { $ne: 0 },
    }),
    InventoryMovement.exists({
      tenant: tenantId,
      $or: [
        { unitCostWithoutVat: { $ne: 0 } },
        { totalWithoutVat: { $ne: 0 } },
        { totalWithVat: { $ne: 0 } },
      ],
    }),
  ];

  if (session) {
    for (const query of queries) {
      query.session(session);
    }
  }

  const labels = [
    "products",
    "membershipPlans",
    "userMemberships",
    "carts",
    "orders",
    "coupons",
    "couponOrders",
    "creditLedger",
    "legacyCreditBalances",
    "pricedEvents",
    "pricedSupplyOrders",
    "inventoryCosts",
    "inventoryMovementCosts",
  ] as const;

  const results = await Promise.all(queries.map((query) => query.exec()));
  const blockingSources = labels.filter((_, index) => Boolean(results[index]));

  if (blockingSources.length > 0) {
    conflict({
      message:
        "Workspace currency cannot be changed after financial data exists.",
      code: "TENANT_CURRENCY_CHANGE_REQUIRES_MIGRATION",
      details: {
        currentCurrency: current,
        requestedCurrency: requested,
        blockingSources,
      },
    });
  }

  return requested;
};
