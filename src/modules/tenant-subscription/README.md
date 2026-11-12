# Tenant subscription billing

This module owns the studio's subscription to shario.io. It is intentionally
separate from customer checkout and customer memberships.

## Code-first plans and currencies

Skab has four fixed plans (`starter`, `professional`, `studio_plus`, and
`enterprise`). Plan entitlements are defined in `tenant.plan.ts`, not stored as
editable database records. Every definition has an explicit immutable version.
To change entitlements, add a new version and advance `currentVersion`; never
edit a version already assigned to a tenant. Tenant and subscription records
store the applied version so existing customers can remain grandfathered.

Starter, Professional, and Studio Plus are self-serve. Their recurring Stripe
Prices use stable lookup keys such as `skab_professional_monthly_v1` and can
also use versioned `*_V1_PRICE_ID` environment variables. The original six
unversioned Price ID variables remain v1-compatible during migration.

The current Plan V3 offer accepts new self-serve subscriptions in `CZK` and
`EUR`, with `EUR` as the fallback. The V2 founding offer remains in immutable
commercial history for existing subscriptions. Configure each recurring Price
with the exact code-owned amounts. Checkout explicitly selects one and the
subscription stores its actual billing currency, interval, plan version, Price
ID, and lookup key. An active subscription cannot silently switch currency
during a plan change.

The tenant's operational commerce currency is independent from this billing
currency. For example, a studio can sell bookings in PLN while paying Skab in
EUR.

## Lifecycle

1. Tenant registration creates a `pending` subscription record without Stripe.
2. Completing onboarding starts one 14-day Professional trial without a card.
3. Choosing a plan opens Stripe Checkout. A remaining trial is preserved when
   more than 48 hours remain. Checkout is blocked during the final 48 hours so
   confirming a plan can never charge the owner before the promised trial end.
   The owner can return after the trial lifecycle has ended to start paid
   service without a trial.
4. Stripe webhooks are authoritative for paid state and tenant entitlements.
5. Failed payments receive a seven-day grace period. Expired trials and unpaid
   subscriptions become restricted without deleting tenant data.

## Owner API

All routes are tenant-scoped from the access token. Owners can mutate billing;
tenant administrators can view the overview and invoices.

- `GET /tenants/current/subscription`
- `GET /tenants/current/subscription/invoices`
- `POST /tenants/current/subscription/checkout`
- `POST /tenants/current/subscription/change-preview`
- `POST /tenants/current/subscription/change-plan`
- `POST /tenants/current/subscription/cancel`
- `POST /tenants/current/subscription/resume`
- `POST /tenants/current/subscription/portal`

Upgrades and monthly-to-yearly changes are applied immediately using Stripe
pending updates and an immediate prorated invoice. Downgrades and
yearly-to-monthly changes are scheduled at the current period end with a Stripe
Subscription Schedule. Cancellation is scheduled for the period end and can be
reversed before then.

## Stripe configuration

The immutable commercial-offer catalogue in
`tenant-subscription.commercial.ts` owns the only supported amounts, lookup
keys and entitlement versions. Do not create or edit production Prices by
hand.

The catalogue command is read-only by default. It compares Stripe with the
current code-owned offer and prints the Products and Prices it would create:

```bash
npm run stripe:tenant-catalog
```

Test-mode creation is explicit and idempotent:

```bash
STRIPE_TENANT_BILLING_MODE=test npm run stripe:tenant-catalog -- --apply
npm run stripe:tenant-catalog:verify
```

Live mode is protected by both the key/mode pair and an offer-specific
confirmation. Live planning, verification, and apply also fail closed unless
`STRIPE_AUTOMATIC_TAX_ENABLED=true`. Activate Stripe Tax, configure legal tax
registrations and invoice branding, and verify the setting before running the
live command. Replace the example offer ID only when the code-owned offer is
intentionally versioned:

```bash
STRIPE_TENANT_BILLING_MODE=live npm run stripe:tenant-catalog -- \
  --apply --live --confirm-live=plans_v3_2026_v1
STRIPE_TENANT_BILLING_MODE=live npm run stripe:tenant-catalog -- \
  --verify --live
```

The command prints the six offer-scoped
`STRIPE_PLANS_V3_2026_V1_*_PRICE_ID` values after a successful apply or verify.
Store them in the matching environment. The founding offer's
`STRIPE_FOUNDING_2026_V1_*` variables and versioned V2 aliases remain available
for historical subscriptions; versioned V3 aliases are also accepted. The
offer-scoped IDs make commercial history and configuration drift explicit.

Every checkout validates the active recurring Price before creating a Stripe
Customer or Session: lookup key, plan/offer/version metadata, interval, exact
CZK/EUR minor-unit amounts, exclusive tax behavior, Product metadata and
test/live mode must all match. Webhook projection repeats the canonical
Price/metadata checks before it can mutate subscription or tenant
entitlements. A drifted or unknown Price therefore fails closed.

Stripe catalogue objects are create-only under this workflow. If an existing
Product or Price differs in any way—including name or metadata—the command
hard-fails in plan, verify and apply modes and does not edit, reactivate,
deactivate or transfer it. Add a new commercial offer and lookup keys instead
of repairing an object that may already have subscriptions attached.

### Stripe Billing Portal

Skab uses a dedicated Portal configuration instead of the Stripe account's
default configuration. It enables payment-method updates, billing name,
address, phone and tax-ID updates, plus invoice viewing and downloads.

Stripe-side plan switching, pausing, cancellation, billing-email changes and
the shareable Portal login page are disabled. Those operations remain
authenticated and controlled by Skab.

Create or reconcile the configuration separately for Stripe sandbox and live
mode:

```bash
npm run stripe:setup-billing-portal
```

Copy the returned `bpc_...` value into
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID` for the matching environment. The
setup command is idempotent and updates the existing managed configuration.
Optional public legal URLs can be supplied with:

- `STRIPE_BILLING_PORTAL_PRIVACY_POLICY_URL`
- `STRIPE_BILLING_PORTAL_TERMS_OF_SERVICE_URL`

Portal sessions are created only for an authenticated tenant owner, on demand,
with a tenant-specific return URL. The endpoint is rate limited and the
short-lived session response is marked `no-store`.

Subscribe the dedicated webhook endpoint to at least:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `customer.subscription.trial_will_end`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `invoice.payment_action_required`
- `invoice.finalization_failed`
- `invoice.updated`
- `invoice.marked_uncollectible`
- `invoice.voided`
- `subscription_schedule.updated`
- `subscription_schedule.aborted`
- `subscription_schedule.completed`
- `subscription_schedule.released`
- `subscription_schedule.canceled`

Webhook event IDs are stored idempotently. Failed processing attempts can be
reclaimed, while older subscription snapshots cannot overwrite a newer local
projection.

### Smart Retries

Smart Retry timing is configured in each Stripe environment, not through the
Stripe API. In **Billing > Revenue recovery > Failed payments**, enable Smart
Retries for subscriptions. Stripe's recommended starting policy is 8 attempts
within 2 weeks. Set the final subscription action to `unpaid` so Skab can
restrict feature access without deleting tenant data or canceling on the
tenant's behalf.

The webhook projection stores the failed-attempt count, Stripe's
`next_payment_attempt`, the hosted recovery invoice, and terminal recovery
outcomes. `invoice.paid` and `invoice.payment_succeeded` clear the recovery
state and restore access based on the current Stripe subscription snapshot.
Skab grants a seven-day application grace period from the first `past_due`
state; subsequent retry failures never extend that deadline. Stripe remains
authoritative for payment attempts, and a successful payment after restriction
restores access automatically.

Configure the same retry policy separately in Stripe sandbox and live mode.
Use a Stripe test clock and a declining test payment method to verify the full
failure, retry and recovery lifecycle before enabling live billing.

### Tenant billing emails

Skab sends localized transactional billing notices to the current tenant owner
in the tenant's default language. The application sends:

- one reminder three days before a local card-free trial expires;
- one notice after the first failed invoice attempt (not every Smart Retry);
- a higher-priority payment-authentication notice when required;
- an invoice-finalization warning for missing billing or tax details;
- a recovery confirmation only when a previously failed invoice is paid; and
- a terminal notice when Stripe stops attempting collection.

Email intents are written to a durable MongoDB outbox with unique delivery
keys. A one-minute worker claims messages atomically, retries transient SMTP
failures with exponential backoff, and stops after eight attempts. A stable
message ID further reduces duplicates. Billing webhooks only wait for the
outbox write, not the external SMTP request.

Set `TENANT_BILLING_EMAILS_ENABLED=true` and configure `EMAIL_USER`,
`EMAIL_PASSWORD`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`,
`EMAIL_FROM_NAME`, and `EMAIL_REPLY_TO`. Use a verified sender domain with SPF,
DKIM and DMARC before production.

In Stripe **Billing > Subscriptions and emails**:

- enable successful-payment receipts and finalized invoice emails;
- enable Stripe's trial-ending email for Stripe-managed trials; and
- disable Stripe's failed-card and 3D Secure reminder emails when Skab's
  billing emails are enabled, otherwise owners can receive duplicate recovery
  notices.

The local reminder job intentionally handles only trials without a Stripe
subscription. Once a remaining trial is transferred to Stripe, Stripe's own
trial reminder provides the payment terms and card-network messaging.

If the in-app upgrade, downgrade and cancellation policy is authoritative,
disable those controls in the Stripe Customer Portal and leave payment-method,
invoice-history and tax-information management enabled.
Set `STRIPE_AUTOMATIC_TAX_ENABLED=true` only after Stripe Tax is activated and
your legal tax registrations and invoice branding are configured. Live
catalogue readiness and live Checkout reject a false or missing value rather
than creating tax-unsafe subscriptions. Checkout always collects billing
addresses and supports customer tax IDs.

The legacy tenant feature authenticator applies subscription access after JWT
verification. The newer authentication, onboarding and billing routes remain
outside that guard so a restricted owner can recover the account. Keep support
and data-export recovery routes outside the guard as those routes are added.

The Stripe webhook endpoint is:

`POST /webhooks/stripe/tenant-subscriptions`

