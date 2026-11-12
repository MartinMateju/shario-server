# Membership V1

Membership V1 separates a stable `MembershipPlan` identity from immutable
published `MembershipPlanVersion` snapshots. Customer `UserMembership` records
also retain their complete purchased terms, price, location scope and benefits,
so later plan edits never alter an existing contract.

## Lifecycle

- Owners create/edit drafts, then publish, archive or duplicate plans.
- Editing a published plan forks a new draft; public catalog selection always
  follows `currentPublishedVersion` and never the highest version number.
- Plans support recurring month/year billing and fixed durations. Every price is
  a positive integer ISO-4217 minor-unit amount; versions may contain multiple
  currencies. Free/complimentary access is assigned by an owner with the
  `complimentary` reason rather than sent through Stripe Checkout.
- Checkout creates a pending local membership and a Stripe Checkout Session as a
  **direct charge on the tenant's connected account**. There is no platform-charge
  fallback. A signed Connect webhook that explicitly reports a paid payment is
  the primary activation source.
- One partial unique index permits only one open membership per tenant/customer.
- Manual/offline assignments are deliberately non-renewing because no payment
  authority exists to confirm a later period.

## Benefits and entitlements

The first-release owner UI deliberately offers three understandable benefits:

- **Monthly credits** are stored as a `credit` allowance. They are granted only
  after a paid period is confirmed. Any positive balance from the preceding
  period is expired before the new grant, so credits never roll over.
- **Product/service discount** is stored as one `percentage` benefit targeting
  `products`. For an authenticated customer with a current paid membership it
  is applied automatically to server-priced checkout units. Selected-location
  plans discount only matching order lines.
- **Custom perk** is an enabled boolean with a customer-facing label (for
  example, "Unlimited coffee"). It is informational and has no consumable
  balance.

Legacy published snapshots may still contain the wider typed allowance,
percentage, limit and boolean vocabulary. The simplified editor preserves
those benefits unchanged instead of silently discarding them. Allowances use
an append-only ledger plus materialized balances. `resolve`, `redeem`,
`reverse`, `adjust`, period-grant and expiration operations are transactional
and idempotent. Adjustment reasons and fields are explicitly whitelisted.

Checkout records the chosen membership discount identity, percentage,
pre-discount subtotal and monetary saving in immutable `Order.appliedDiscount`
data. Discounted order lines remain valid invoice snapshots and exactly match
the Stripe amount. Percentage coupons and membership discounts are mutually
exclusive; the pricing selector chooses the larger monetary saving and prefers
membership on an exact tie so a limited-use coupon is not wasted. Existing
gift-voucher codes remain account credit (a payment method), not a stackable
percentage discount.

Automatic booking/firing consumption is intentionally outside this module's V1
boundary: those domains do not currently expose one unambiguous mapping from a
resource to a benefit key. They must call
`membershipEntitlementService.resolve/redeem/reverse` explicitly with their own
stable reference and idempotency key. This avoids silently spending the wrong
benefit.

Refund and dispute automation is also outside V1 because partial-refund and
already-consumed-benefit semantics require an explicit business policy. A
Stripe refund by itself does not cancel a membership, cancel its Subscription,
or restore/expire entitlements. The owner must also cancel the membership in
the app (and adjust benefits when appropriate). A dispute requires operational
review and manual cancellation/adjustment if access should be revoked. Future
automation must add explicit refund/dispute event handling and idempotent ledger
rules before those events can change membership state.

## Routes

- Public: `GET /public/tenants/:tenantSlug/memberships`
- Owner plans: `/memberships/plans`, `/:id/publish`, `/:id/archive`,
  `/:id/duplicate`
- Owner customers: `/memberships/user-memberships`, `/:id`,
  `/:id/adjustments`, `/:id/cancel`, and `/memberships/assign`
- Customer: `/memberships/mine`, `/mine/ledger`, `/mine/invoices`,
  `/mine/cancel`, `/mine/resume`, `/mine/billing-portal`, and
  `/memberships/checkout`

Customer legal/history and recovery routes remain available if the tenant later
disables the membership module; new checkout and the public catalog remain gated.
Owner routes require `memberships.view` or `memberships.manage` and enforce the
operator's assigned-location scope against the relevant draft/published snapshot.

Invoice serializers expose only authenticated local API URLs. Stripe hosted/PDF
URLs are hidden server fields and the document endpoint proxies their bytes.

## Operations

### Monthly plan changes

`POST /memberships/mine/plan-change` accepts `planId`, the current published
`planVersionId`, `termsAccepted: true`, optional `locationId`/`locale`, and a required
`Idempotency-Key` header. `DELETE /memberships/mine/plan-change` removes an upcoming
change. Both return `{ membership }`. The membership DTO includes
`canSchedulePlanChange` and `scheduledPlanChange` (frozen target terms, amount,
currency, effective date, and `preparing`/`scheduled`/`cancelling` status).

Only active, paid, automatically renewing monthly Stripe memberships can schedule
a change to another monthly plan in the same currency. Trials, paused/past-due
memberships, scheduled cancellations, existing external schedules, and custom
Stripe billing arrangements require studio assistance. An upcoming plan change
must be removed before requesting membership cancellation.

Scheduling creates a connected-account subscription schedule from the existing
subscription, retaining its current phase and adding the target at the next
monthly renewal. Both schedule updates and phase transitions disable proration.
No Checkout Session, additional subscription, or immediate invoice is created.
Cancelling the change releases the schedule while retaining the subscription.

A matching paid recurring invoice activates the frozen target inside the same
transaction as allowance expiry and period grants. Previous contract terms are
archived in `planChangeHistory`. Time carry uses only unused regular hours from
the old adjacent period, capped by the old plan's rollover percentage (at most
25% of its old grant); existing carry and adjustments do not roll again. Compatible
time benefits are matched by key or a unique unit/purpose; ambiguous mappings are
rejected. Other old balances expire. The paid target schedule is then released so
the new price continues recurring and another future change can be scheduled.

Durable operation ownership prevents cancellation/scheduling races. Ambiguous
Stripe failures retain the accepted instruction and stable provider idempotency
keys; identical POST/DELETE retries and the existing reconciliation worker recover
them. If preparation never configured the target before renewal, authenticated
old-price state releases any owned unconfigured schedule and removes the pending
instruction, so the paid old-plan renewal remains usable. Cancel/resume locks are
also recovered when authenticated provider state proves their requested effect.
An unattached schedule older than Stripe's idempotency retention is left
for operational reconciliation rather than guessing ownership. A cancellation
that loses a race to renewal does not claim to have reverted the plan.

Stripe implementation references: [subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules),
[create from an existing subscription](https://docs.stripe.com/api/subscription_schedules/create),
[release a schedule](https://docs.stripe.com/api/subscription_schedules/release).
The existing Stripe API pin remains `2023-10-16`, using `iterations: 1` for the
target phase.

- Connect event processing has an identity-validated lease claim, duplicate
  handling and current-object retrieval for out-of-order subscription/invoice
  events.
- `reconcileMemberships` closes expired sessions/periods, expires due benefits,
  syncs non-pending subscriptions and recovers abandoned webhook leases. When a
  paid webhook is missed, it may recover a pending membership only after an
  authenticated Checkout/Subscription retrieval under the membership's stored
  connected-account context confirms payment. Recovery reuses the same
  period-key-idempotent activation/grant path as the webhook handler.
- Lifecycle notification intents use a durable leased outbox.
- Migration is dry-run by default:
  `npm run migration:memberships-v1`; apply with `-- --apply`.
