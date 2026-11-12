# Currency foundation migration

This migration separates a tenant's studio commerce currency from the currency
used to pay Skab's own subscription. It is intentionally **dry-run by default**.

Before applying it, take a database backup and stop writes (or run during a
maintenance window).

```bash
npm run migration:currency-foundation
npm run migration:currency-foundation -- --apply
npm run migration:currency-foundation
```

The final dry-run should report zero automatic backfills. Review every ID in
`manualReview` before enabling the stricter checkout webhook in production.

## Safe automatic backfills

The script applies only deterministic legacy defaults:

- missing `Tenant.planVersion` becomes `1`;
- missing tenant operational currency becomes `CZK`, the legacy application
  currency;
- missing Product and MembershipPlan currency becomes that tenant's operational
  currency;
- missing MoneyCredit ledger and transaction currency becomes that tenant's
  operational currency;
- missing `TenantSubscription.trialPlanVersion` becomes `1`.

An unsupported, non-empty tenant currency is never changed automatically. It is
reported for manual review, and all dependent records for that tenant are
skipped.

## Records that must not be guessed

The script only reports these records:

- Cart or Order without `currency` and `expectedAmountMinor` (and historical
  Order without `paidAmountMinor`);
- an active Stripe-backed TenantSubscription without `billingCurrency`,
  `planVersion`, or `stripe.priceLookupKey`;
- CouponOrder without its immutable `currencySnapshot`;
- priced Event, SupplyOrder, InventoryItem, or InventoryMovement records
  without their own `currency` snapshot.

Do not calculate these from the tenant's current setting. The tenant may have
changed currency, a Stripe discount may have changed the amount collected, or
the customer may be grandfathered onto a legacy subscription price.

### Stripe Order and Cart recovery

For an Order with `stripe.sessionId`, retrieve that Checkout Session from
Stripe and verify all of the following before updating either document:

1. `client_reference_id` equals the Order ID;
2. `metadata.tenantId` equals the Order tenant;
3. `session.currency` is one of the supported studio currencies;
4. `session.amount_total` is a nonnegative safe integer.

Then set Order and its referenced Cart `currency` to the uppercase Stripe
currency and `expectedAmountMinor` to `session.amount_total`. Set
`paidAmountMinor` only when Stripe reports the Session as paid. A credit-only
legacy Order without a Stripe Session requires an application/audit-backed
manual decision; do not assume zero merely because its current Mongoose default
is zero.

Pending Stripe Orders are the highest priority: a missing snapshot hydrates as
the schema default `0`, and the webhook correctly rejects a nonzero Stripe
payment rather than processing an unverifiable amount.

### Subscription recovery

Retrieve the Stripe Subscription and its current item Price. Populate:

- `billingCurrency` from `subscription.currency`;
- `stripe.priceId` from the current subscription item;
- `stripe.priceLookupKey` from the Stripe Price lookup key;
- `planVersion` from the immutable local price-ID/lookup-key catalog mapping.

If the Price cannot be mapped to a retained catalog version, keep the tenant
blocked for manual billing review. Never replace it with the current plan
version or the EUR fallback.

### Coupon Order recovery

Recover `currencySnapshot` from the associated verified Stripe Checkout
Session or another immutable payment record. A current Product/Tenant currency
is not proof of the historical payment currency.

## Ancillary operational-currency records

New Event, SupplyOrder, InventoryItem, and InventoryMovement records persist a
server-derived `currency` snapshot. Event prices, supply-order prices, inventory
unit costs, and inventory movement totals are validated against that currency;
calculated inventory totals, VAT, and weighted costs are rounded through ISO
minor units (including zero-decimal JPY and CLP).

Legacy records are intentionally not backfilled by this migration. A legacy
record with no currency and non-zero money remains readable and can receive
non-financial edits, but the API rejects monetary edits until an accountant-led
migration establishes its historical denomination. A zero-value record can be
assigned the tenant's current currency when its first monetary value is added,
because there is no historical amount to relabel.

For manual review, inspect missing `currency` on records where any of these
fields are non-zero:

- Event: `priceEstimate`, `finalPrice`, or `depositPaid`;
- SupplyOrder: `price` or `depositPaid`;
- InventoryItem: `averageUnitCostWithoutVat`;
- InventoryMovement: `unitCostWithoutVat`, `totalWithoutVat`, or
  `totalWithVat`.

Do not infer these snapshots from the tenant's current setting. Backfill only
from contemporaneous invoices, payment records, or another immutable source.
