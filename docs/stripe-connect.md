# Stripe Connect for tenant payments

Skab uses one Stripe connected account per tenant/legal seller. Customer
payments for bookings and other studio commerce are direct charges on that
connected account. Skab's own tenant subscription remains a separate platform
billing flow under `modules/tenant-subscription`.

## Account model

Skab creates a modern Standard-equivalent account with this controller:

- fees payer: connected account
- payment losses: Stripe
- requirement collection: Stripe
- Stripe Dashboard: full

Country and capabilities are deliberately omitted at creation. Stripe-hosted
onboarding determines availability and collects identity, business, tax and
bank details. Skab persists only the Stripe account ID, capability/status
booleans, country/currency, requirement field names, and sync timestamps. It
does not receive or store KYC answers or bank account details.

Only the immutable owner and built-in administrator roles receive
`payments.connect.manage`. Members with `payments.view` may read the connection
status but cannot create links or change the connection. Custom roles cannot
be granted Connect management.

## API

All authenticated endpoints are tenant-scoped by the access token and
workspace membership. Client-supplied tenant IDs and redirect URLs are never
accepted.

```text
GET  /tenant-payments/connect
POST /tenant-payments/connect/onboarding   { "locale": "en" | "cs" }
POST /tenant-payments/connect/dashboard
```

The onboarding endpoint returns a short-lived Stripe-hosted Account Link. Its
return and refresh destinations are generated from the configured root domain,
the tenant slug stored in MongoDB, and the validated locale. A return URL means the user
returned from Stripe; it is not proof that onboarding completed. The frontend
must fetch `GET /tenant-payments/connect` again.

Full Dashboard accounts use `https://dashboard.stripe.com/`. This is not a
platform-generated login link and is therefore returned with
`singleUse: false`.

## Webhook

Create a dedicated Stripe Connect event destination:

```text
POST /webhooks/stripe/connect
```

For the production API host, the full destination is
`https://api.shario.io/webhooks/stripe/connect`. There is no `/api` prefix and
the route is not `/api/stripe/connect/webhook`.

Set its signing secret in `STRIPE_CONNECT_WEBHOOK_SECRET`. The route consumes
the raw request body before `express.json()`, synchronizes `account.updated`,
and dispatches namespaced Skab Checkout lifecycle events. Checkout Sessions
created independently by a full-dashboard tenant are acknowledged as
unrelated. A namespaced Skab event fails closed when its tenant, account,
livemode, amount, currency, or durable order snapshot does not match.

Never reuse `WEBHOOK_SECRET` (legacy customer Checkout) or
`STRIPE_BILLING_WEBHOOK_SECRET` (Skab tenant subscriptions).

The server validates its complete environment during startup. In production,
startup fails if `STRIPE_CONNECT_WEBHOOK_SECRET` is absent; development and
test environments may omit it while Connect webhooks are not being exercised.

For local connected-account events, authenticate the Stripe CLI and start the
listener without positional arguments:

```text
stripe login
stripe listen --forward-connect-to http://localhost:4000/webhooks/stripe/connect
```

The CLI prints a temporary `whsec_...` signing secret. Put that value in the
local `STRIPE_CONNECT_WEBHOOK_SECRET` and restart the server; do not pass the
secret to `stripe listen` as an argument.

Subscribe the Connect destination to these connected-account events:

- `account.updated`
- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.created`
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `invoice.voided`
- `invoice.marked_uncollectible`
- `charge.refunded`
- `refund.updated`
- `refund.failed`

The subscription and invoice events above are required by customer Membership
V1. Destination delivery must include events on connected accounts. Membership
Checkout metadata is namespaced with `skabFlow=customer_membership_v1`; the
server maps the event's connected account to its tenant before comparing any
metadata. A Checkout completion without `payment_status=paid` never activates a
membership. Event claims are durable/leased and published plan terms are read
from the stored membership snapshot, not mutable Stripe metadata.

The three refund events reconcile supported booking/checkout refunds. Membership
V1 deliberately does not automatically apply refund or dispute events to membership
entitlements. Refunding a fixed or recurring membership charge in Stripe
does not alter the local membership, its Subscription, or its entitlements. The
operator must also cancel the membership through Skab (which cancels/schedules
the connected-account Subscription where applicable) and use an audited benefit
adjustment when the chosen refund policy requires it. Partial refunds are always
manual because V1 has no safe generic mapping from refunded money to consumed
benefits. Disputes require operational review and manual cancellation/adjustment
when access should be revoked. Add explicit event subscriptions, connected-
account retrieval, idempotency, and ledger semantics before automating either
workflow.

### Draining pre-Connect platform Checkout Sessions

The legacy `POST /webhook` route is migration compatibility code, not a second
permanent commerce path. It continues to use the old platform-account signing
secret in `WEBHOOK_SECRET` and is disabled by default:

```text
LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED=false
```

Use this rollout order when moving an existing deployment to direct Connect
charges:

1. Deploy the compatibility release with
   `LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED=true` **before** the release that
   starts creating Connect Sessions.
2. Switch all new tenant checkouts to direct connected-account charges. The
   Connect destination receives those events at `/webhooks/stripe/connect`;
   the legacy route ignores every event carrying `event.account`.
3. Keep the flag enabled while old platform Sessions complete or expire and
   while failed Stripe deliveries retry. The Checkout expiry (currently 30
   minutes) is only the minimum drain period. Monitor old pending orders,
   vouchers, Stripe event delivery, and retryable processing errors until no
   eligible platform Session remains.
4. Set `LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED=false` and redeploy. Leave the
   HTTP route in place until the old Stripe event destination has also been
   disabled, so signed late deliveries receive an intentional acknowledgement.

Even while enabled, the legacy path can claim only a tenant-scoped order whose
stored Session, amount, currency and platform livemode match and whose
connected-account snapshot is empty. It supports the pre-Connect booking,
studio-credit and voucher flows (including safe Session expiry), preserves the
same idempotent/retryable processing leases, and cannot fulfill a Connect-owned
order. Remove this compatibility code after the migration has been observed to
be fully drained.

For a paid custom domain, add its exact browser origin to
`CORS_ALLOWED_ORIGINS` and keep the matching tenant domain record active. The
server uses the request `Origin` only after matching it to the tenant's standard
host or active custom-domain allowlist; arbitrary redirect origins are ignored.

## Checkout readiness

Every online tenant checkout must call:

```ts
const account = await requireReadyTenantConnectedAccount(tenantId);
```

It blocks unless details are submitted and both charges and payouts are
enabled. The three implemented Checkout Session flows explicitly allow card
payments only; enabling additional payment methods requires a lifecycle review
for asynchronous completion and expiration events. Every Stripe create,
retrieve, expire, refund, and dispute operation
for that order must then use:

```ts
getConnectedAccountRequestOptions(account.stripeAccountId);
```

Persist the connected account ID on the order/payment snapshot and verify that
`event.account` matches it before fulfillment. Do not fall back to a platform
charge when a connected account is unavailable.

Paid orders remain `pending_order` when a transient fulfillment dependency
fails. The processing lease is released and the Connect webhook returns a
non-success response so Stripe retries. Customer polling reports these orders
as non-terminal processing rather than incorrectly showing a failed payment.
Voucher administration and customer email delivery are checkpointed
separately, so a retry skips a channel already recorded as sent.

### Current checkout constraints

Checkout does not support splitting one payment between studio credits and a
card. A customer must either pay the full amount by card or use the dedicated
full-credit checkout when their balance covers the complete order. The API
rejects a non-zero `creditsToApplyMajor` value instead of silently accepting
an unsafe partial-credit allocation.

Voucher promo codes are not checkout discounts. A signed-in customer first
redeems a voucher into studio credits and may then use those credits in a
later full-credit checkout. The API rejects a non-empty `promoCode` on booking
checkout so the UI and the recorded payment can never disagree about the
amount paid.

Guest checkout cannot purchase a `guest-increase` item. Increasing an existing
booking requires an authenticated account so ownership of the booking can be
verified.

## Booking and course receipts

Booking/cart Checkout Sessions pass the buyer's email as both `customer_email`
and `payment_intent_data.receipt_email`. This applies to signed-in customers
and public guest course checkout, which uses the same checkout service. Stripe
sends the payment receipt after a successful live payment even when the
connected account's automatic receipt email setting is disabled. A tenant's
Connect registration alone does not enable receipt delivery.

These are direct charges, so receipts use the tenant's connected-account
branding and public business/support details. Tenants maintain those details
in their Stripe Dashboard. Skab does not send a second payment receipt or
enable Stripe's optional one-time invoice creation for booking checkout.
Existing Skab invoice workflows remain separate.

Skab sends the booking/course confirmation after the paid order has finished
fulfillment. The confirmation contains the booked items, dates/times in the
location's timezone, studio address and customer portal link. The notification
job runs every two minutes and retries failed deliveries. Access codes retain
their existing separate delivery schedule.

Confirmation attempts are recorded as `PROCESSING` and become `SENT` only
after the email transport accepts the message. Interrupted attempts can be
retried after 15 minutes, within the existing three-attempt/12-hour window.
Each job run has a unique lease owner; stale workers cannot overwrite a newer
worker's result. As with other SMTP delivery, a crash after transport acceptance
but before recording `SENT` can result in a duplicate on retry. Existing `SENT`
records are not replayed, including historical records created by the old job.

Stripe receipt documentation:

- [Receipts and paid invoices](https://docs.stripe.com/receipts)
- [Explicit receipt email](https://docs.stripe.com/api/payment_intents/create#create_payment_intent-receipt_email)

### Receipt delivery verification

1. Use a tenant with completed Connect onboarding and its own branding/support
   details. Complete signed-in booking and public guest course checkouts with
   a buyer email distinct from the tenant owner's email.
2. Inspect each Checkout Session's PaymentIntent on that connected account:
   `receipt_email` must be the buyer's email and the payment must belong to
   the tenant, not the platform.
3. Confirm successful fulfillment produces a Skab confirmation with the
   correct booking details; unpaid, pending-fulfillment and failed orders must
   not send a booking confirmation. Replaying the payment webhook must not
   create another Checkout Session.
4. Stripe does not automatically email receipts for test payments. Inspect
   the test Charge's receipt in Stripe or manually send a test receipt from
   its Dashboard. Verify automatic delivery with an authorized live payment
   during release validation; it is not exercised by the automated tests.

The receipt setting applies to newly created booking Checkout Sessions.
Existing sessions and saved recovery payloads retain their original payment
parameters so recovery does not break Stripe idempotency.

## Launch checklist

1. Activate Stripe Connect on the platform account and complete the platform
   profile.
2. Review Stripe's supported countries, payment methods and settlement
   currencies for every launch market.
3. Configure platform branding, support details, terms and privacy notices.
4. Add the Connect webhook destination and subscribe to `account.updated` plus
   the commerce lifecycle events actually handled by the application.
5. Keep manual cash/bank payment methods separate. The implemented direct-
   charge paths are booking/cart checkout, studio-credit purchase, voucher
   purchase, and customer memberships (recurring or fixed-duration). Customer
   membership billing uses connected-account Checkout/Subscriptions and must
   never reuse Skab platform-subscription Price, Customer or Subscription IDs.
6. Test onboarding, requirements becoming due, restricted accounts, refunds,
   disputes and webhook replay in Stripe test mode.
7. Monitor unknown-account and failed commerce webhook logs. Reconcile Stripe
   account IDs operationally; never infer tenant ownership from webhook
   metadata alone.

### Membership smoke test

Before enabling the memberships module for a production tenant:

1. Publish a test plan and confirm the public catalog shows only the stable
   plan's exact current published version, never its newer draft.
2. Complete a connected-account recurring Checkout. Confirm the local record
   remains `pending` until a signed paid webhook arrives, then becomes active
   with one period grant and one notification even when events are replayed.
3. Repeat with a fixed-duration Checkout and verify its local invoice/detail and
   authenticated document URL contain no raw Stripe hosted URL.
4. Replay paid/payment-failed/subscription-updated events out of order. The
   current Stripe object must win and the period ledger must not double-grant.
5. Schedule cancellation, resume it, then schedule it again. Verify the Stripe
   request, local status and billing portal agree each time.
6. Cancel immediately and from Stripe Dashboard. Confirm balances (including
   the legacy credit mirror) expire exactly once and the one-open slot releases.
7. Allow a Checkout Session and a fixed membership to expire, then run
   `reconcileMemberships`; confirm pending/open records close and benefit
   expiration/audit records are append-only.

Stripe Connect reduces Skab's exposure to KYC and payout handling, but it does
not remove Skab's obligations for platform terms, privacy, tax treatment,
sanctions/market availability, fraud monitoring and customer support.
