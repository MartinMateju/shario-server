# Tenant subscription projection safeguards

Tenant billing webhooks project Stripe state; they do not grant a plan from metadata alone. Initial binding and replacement require a signature-verified `checkout.session.completed` event whose Session client reference, Session metadata, Subscription metadata, customer, and subscription all identify the same local workspace. Checkout creation already supplies these fields and persists the Stripe customer before returning the Session.

- Ordinary subscription or invoice events can update only the currently bound Stripe subscription. An unbound manual active grant remains unchanged, including its existing limits.
- Checkout idempotency includes the currently bound Stripe subscription ID. Retries for one generation reuse the Session, while a subsequent canceled replacement can start a new Session instead of reusing an older completed checkout.
- A replacement also requires a terminal local subscription (`canceled`, `expired`, or `incomplete_expired`) and a later Stripe creation timestamp. New projections store `stripe.subscriptionCreatedAt`; legacy projections can use `currentPeriodStart` as a conservative lower bound. A terminal bound record missing both must have its billing history reconciled before Checkout is created. The API rejects that request before contacting Stripe, rather than accepting payment without activating service. Do not clear the binding or fabricate timestamps to bypass this check.
- Initial subscription/invoice events may arrive before Checkout completes and are acknowledged without binding. Completed Checkout retrieves the current expanded `latest_invoice` and applies its recovery state through the same binding gate; the usual billing email intent uses the existing invoice-based deduplication key. Events for a retired subscription cannot change the current plan or send its failure/recovery email.
- Projection writes acquire an internal revision on the subscription inside a Mongo transaction, reread the event cursors, and commit the subscription and tenant plan together. Competing transactions retry against the latest state. Workspace notifications run after commit. This uses the replica-set transaction infrastructure already required by commerce; no data migration or new index is required.
- Subscription and invoice recovery retain separate ordering cursors. Stripe webhook handlers retrieve the latest Subscription rather than applying a stale event payload. Stripe event timestamps have one-second resolution; this remains an eventually consistent projection, not an ordering guarantee between distinct events created within the same second.
- Local trial Checkout becomes available immediately at `trialEndsAt`, even if the hourly lifecycle job has not updated `trialing` to `expired`. The final unexpired 48 hours remain blocked to avoid charging before the trial ends.
- Public membership purchase availability requires a usable subscription and both the memberships and payments modules, matching the public catalogue route. Existing customer recovery and billing routes retain their existing access behavior.

These changes do not migrate or normalize manual grants, change Stripe records, or invalidate the existing short-lived subscription-access cache. A valid user-initiated Checkout can replace a manual grant with the purchased plan.

Focused validation:

```sh
node node_modules/vitest/vitest.mjs run tests/integration/tenant-subscription/tenant-subscription-sync.test.ts tests/unit/tenant-subscription/tenant-subscription.webhook-binding.test.ts tests/unit/tenant-subscription/tenant-subscription.checkout-currency.test.ts tests/unit/tenant-subscription/tenant-subscription.stripe-contract.test.ts tests/unit/tenants/tenant-public-site.capabilities.test.ts --maxWorkers=1
```

The Mongo integration uses an isolated in-memory replica set. It verifies manual grants, initial event ordering, replacement/retired events, tenant/customer identity, legacy history, concurrent projection ordering, and rollback when the tenant update fails. No test contacts Stripe or sends email.
