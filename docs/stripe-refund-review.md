# Dashboard refund reconciliation and staff review

## Policy and scope

The approved policy records money returned by Stripe and leaves decisions about
bookings, wallet credit, subscriptions and membership entitlements to staff.
Pending/requires-action refunds do not count as returned money. Failed/canceled
refunds remain visible for review. A staff resolution records the decision;
it does not execute or reverse a financial transaction or grant benefits.

A refund observed before fulfillment prevents automatic late fulfillment. If
staff elect to retain benefits, arrange them explicitly through the existing
studio tools and record the adjustment/reference in the review. Never replay a
payment to try to bypass the refund block. Already fulfilled benefits are not
revoked. A concurrent external refund that Stripe has not yet delivered cannot
be predicted by Shario; review must check for earlier wallet compensation too.
Whole-class cancellation and the existing booking cancellation-credit policy
are unchanged.

## Required rollout checks

1. Deploy backend then the client refund-review UI. Verify MongoDB permissions
   allow creation/indexing of PaymentRefundReconciliation,
   PaymentRefundObservation and PaymentRefundReviewResolution. Preparation is
   narrow, once per process on first reconciliation/review, and retryable.
   Also verify the non-unique `booking_payment_refund_provider_lookup` index on
   `BookingPaymentRefund` (`tenant`, `connectedAccountId`, `refundId`, all
   ascending). Normal application model initialization creates it. If automatic
   index creation is disabled, create only this named index before acceptance;
   do not sync/drop/rebuild the existing indexes.
2. In the Connect event destination, enable `charge.refunded`, `refund.created`,
   `refund.updated`, `refund.failed` in addition to existing lifecycle events.
   Do this for the appropriate test/live modes and connected accounts. Merely
   deploying this code does not change the destination subscriptions.
3. Complete real Stripe **test-mode** full and partial refunds for a booking,
   credit purchase and membership invoice. Capture provider event IDs, resulting
   refund summaries, unchanged benefits, and the staff review/resolution.
   Deliver duplicates and changed-status events. Repeat with a second account.
4. Confirm the operational payment-health check reports unresolved reviews and
   returns healthy after valid resolutions. Repair mapping/provider errors and
   replay rather than dismissing an incomplete review.

Automated evidence uses MongoDB replica-set transactions and fake provider
transports. It does not establish live Stripe delivery, Dashboard configuration,
real refund settlement, or a production historical reconciliation.

## Reviewing an item

Payments lists unresolved reviews for authorized staff with all-location access.
Check the linked order/membership and actual payment in the tenant's Dashboard.
Compare successful/pending/failed amounts, previously restored wallet/voucher
value, consumed membership benefits, and any previous cancellation. Decide and
perform the necessary benefit action in the supported studio workflow; an
explicit decision to retain existing benefits is valid. Enter an action note
and an evidence reference (10–2000 characters each), then resolve the current
snapshot. Notes must not include card details or secrets.

A newer provider state reopens the review. Concurrent/stale acknowledgments
return 409; refresh and inspect the new totals. Pending refunds can be reviewed,
but their eventual success/failure will require another review. Incomplete
bindings or inconsistent provider lists cannot be acknowledged. An operator
must repair the association from provider evidence, then run targeted replay.
Historical mismatches must not be “fixed” by copying Dashboard-editable metadata
into a tenant/payment relationship.

An app-issued refund already allocated to one booking does not prevent
cancellation of the remaining bookings in the same mixed voucher/card order.
The cancellation transaction permits this only when every provider refund is
successful and matches exactly one settled local cancellation record, its exact
refund ID, account/mode/currency/payment, and immutable booking-line funding.
Unknown, pending, failed or inconsistent allocations remain blocked. If the
webhook arrives before the refund worker saves success, cancellation is blocked
until that worker finishes; the next cancellation checks the saved proof without
requiring another webhook. Financial totals, late-fulfillment protection, and
the existing staff review queue remain unchanged. Acknowledging a review does
not allocate an otherwise unallocated Dashboard refund.

## Historical or failed-delivery replay

There is **no automatic account-wide historical backfill**. Previously ignored
Dashboard events may be re-sent after this release; this handler reconciles
before the existing checkout/membership processed-event checks. Refunds outside
Stripe's event resend window can be reconciled by the targeted operator command
below. It retrieves the charge from Stripe using the supplied mapped connected
account, checks its mode, then uses the same provider verification, bounded
pagination, lease, observations and review projection as the webhook. It never
issues a refund or changes benefits.

Run in an approved environment with the correct `MONGO_URI` and `STRIPE_KEY`
provided securely. It does not load `.env`, scan accounts, or print credentials.
First perform the default account/charge verification (no database writes):

```sh
npx tsx src/modules/tenant-payments/scripts/reconcile-payment-refund.ts --account acct_ID --charge ch_ID
```

Then explicitly record/reconcile that one payment:

```sh
npx tsx src/modules/tenant-payments/scripts/reconcile-payment-refund.ts --account acct_ID --charge ch_ID --apply
```

The default preview verifies account/charge access and mode only; full local
binding/refund-list validation occurs during apply. Apply can create a durable
review requiring operator repair. Repeat apply after fixing a verified missing
binding; duplicate current snapshots do not create another financial entry.
Do not run against production without the release operator's authorization.

## Evidence and provider contract

Regression coverage is in
`tests/integration/tenant-payments/payment-refund-reconciliation.test.ts`,
`tests/integration/checkout/booking-payment-cancellation.test.ts` and
`tests/integration/membership/membership-recurring-http.test.ts`. Real Mongo
transactions exercise reconciliation, duplicate and reordered delivery,
partial/full/pending/failed refunds, isolation, early mapping recovery, managed
refund deduplication, staff resolution/version history, and signed webhook
fulfillment/cancellation behavior. The first-use suite does not preinitialize
the reconciliation collections. External network transports are fixtures.

Provider references (checked 2026-11-15):

- [Refund status and lifecycle](https://docs.stripe.com/refunds)
- [Refund objects](https://docs.stripe.com/api/refunds/object)
- [Paginated refunds](https://docs.stripe.com/api/refunds/list)
- [Checkout Session filtering by PaymentIntent](https://docs.stripe.com/api/checkout/sessions/list)
- [Webhook duplicates and event ordering](https://docs.stripe.com/webhooks)
- [Refund event types](https://docs.stripe.com/api/events/types)

Provider reads remain pinned to the application's `2023-10-16` Stripe API
version. This is not an API-version migration. A single captured direct charge
per PaymentIntent is supported; inconsistent charge/payment totals or bounded
pagination limits remain visible as review rather than guessed allocation.
