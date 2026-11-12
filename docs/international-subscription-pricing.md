# International subscription pricing

Skab supports EUR, USD, CZK, GBP, CHF, PLN, DKK, SEK, NOK, CAD, and AUD
for platform billing. Existing studio commerce currencies remain supported.

## Backend price configuration

`src/modules/tenant-subscription/tenant-subscription.prices.ts` holds the current
international offer's per-plan, per-interval currency amounts. Each number is a
positive safe integer in minor units, excluding tax; EUR `3900` means EUR 39.00.
Monthly and yearly amounts can be set independently. Enterprise remains
sales-assisted, with custom annual pricing.

Only the existing EUR and CZK prices have been approved. The other nine
currencies deliberately contain `null`. A currency becomes available for
self-service checkout when every self-service plan has both interval prices.
Missing prices are shown as unavailable and rejected before contacting Stripe;
the server never substitutes EUR, converts exchange rates, or trusts an amount
submitted by the browser. Fill all required values before enabling a currency.

`international_2026_v1` is a new offer with the same V3 plan entitlements. This
branch requires approved prices and Stripe provisioning before production
launch. Existing founding and V3 offer definitions, lookup keys, and amounts are
retained. No live provider objects or existing subscriptions are changed by
editing these files.

After an offer has been provisioned, never edit its amounts or reuse its ID.
Preserve its complete definition in `COMMERCIAL_OFFER_CATALOG`, add a new entry
with a new ID and amounts, and advance `CURRENT_COMMERCIAL_OFFER_ID`. Merely
changing `INTERNATIONAL_OFFER_ID` without retaining the old entry is unsafe.
Existing subscriptions continue to resolve against their own immutable offer.

## API and selection

`GET /public/subscription-catalog` is anonymous and uses only the backend
catalogue. It returns all supported `currencies`, priced `availableCurrencies`,
the current `offerId`, and plan `monthly`/`yearly` maps containing
`{ amountMinor, available, type }`. Missing amounts are `null`. No Stripe price
IDs, lookup keys, tenant information, or provider credentials are returned.

Checkout resolves an explicit billing selection first, then an existing saved
subscription currency, then the configured tenant commerce currency when it is
supported for platform billing. USD is the fallback only when no supported
preference exists. Missing prices never cause a different currency to be used.
An active subscription cannot switch currency during a plan change.

## Provisioning

The existing `stripe:tenant-catalog` command creates a separate set of prices
for the new offer. It generates currency options from each price's own
configured amounts; historical contracts continue to validate only their own
currencies. The default command is a read-only plan; `--verify` checks the
provider and `--apply` writes only under the existing mode guards. Run the test
mode plan, apply, and verification after approving prices. Production requires
the existing explicit live mode confirmation and automatic-tax configuration.
Configure the generated offer-scoped price environment variables rather than
repointing historical ones. This implementation does not run those commands or
change live billing.
