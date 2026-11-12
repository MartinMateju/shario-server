# Studio invoicing

This module creates legal sales documents for a tenant's own customers. It is
separate from the Stripe invoices that Skab receives for the tenant's SaaS
subscription.

Online studio commerce uses Stripe Connect direct charges on the tenant/legal
seller's connected account. Bookings, studio-credit purchases, and voucher
purchases persist that account as an immutable payment snapshot and are
fulfilled only by account-matched Connect webhook events. Skab's own SaaS
subscription remains platform billing. See [Stripe Connect](stripe-connect.md)
for the account, webhook, deployment, and compliance boundaries; legal PDFs
alone are not proof that a merchant-of-record arrangement is compliant.

## Monetary and document rules

- All amounts are integer ISO-4217 minor units. JPY and CLP use exponent zero.
- Checkout prices are currently tax-inclusive. A non-zero tax rate combined
  with `pricesIncludeTax=false` is rejected with
  `EXCLUSIVE_TAX_NOT_SUPPORTED`; exclusive tax must not be silently added to an
  invoice after Stripe charged a different amount.
- A finalized document receives a transactionally allocated, tenant-unique
  number. Invoice and credit-note prefixes share one counter whenever they
  resolve to the same prefix/year series; allocation also advances past all
  legacy type-specific counters before incrementing. Its seller, customer,
  tax, currency, timezone, lines, and source snapshots are not editable
  through the API after issuance.
- When a customer account is linked, the account record is authoritative for
  first name, last name, email, and phone. Legal/business billing fields remain
  invoice-specific. Fully manual legal parties remain supported by leaving the
  customer account link null.
- A correction is another legal document (a credit note), not an edit. Credit
  notes use transaction-current per-line counters and a cumulative cap.
- Issuing a credit note does **not** claim that cash was refunded. Credit notes
  use `paymentStatus=not_applicable`; the original invoice keeps its actual
  payment status. `creditStatus` and `creditedAmountMinor` describe document
  correction state. Actual Stripe/store-credit refunds need their own payment
  workflow.

## Routes

Authenticated customer routes are available even while tenant feature access
is restricted, because customers must retain access to legal documents:

- `GET /invoices/mine`
- `GET /invoices/mine/:id`
- `GET /invoices/mine/:id/pdf`

Workspace routes are protected by subscription access, permissions, and the
resolved all-location/subset scope:

- `GET|POST /invoices`
- `POST /invoices/from-order/:orderId`
- `GET|PATCH /invoices/settings`
- `GET|PATCH /invoices/:id`
- `POST /invoices/:id/finalize`
- `POST /invoices/:id/send`
- `POST /invoices/:id/credit-notes`
- `POST /invoices/:id/payments`
- `POST /invoices/:id/payments/:paymentId/reverse`
- `GET /invoices/:id/pdf`

Manual invoices and credit notes accept an `Idempotency-Key` header or an
`idempotencyKey` body field. Clients should generate one UUID for a user action
and reuse it when retrying that action.

## Manual settlement records

An authorized manager or accountant can record an external settlement against
an issued invoice using `bank_transfer`, `cash`, `card`, or `manual`. This does
not charge a card or call Stripe. Every payment record has a stable identifier,
amount, reference, payment date, recorder and recording time. Both recording
and reversal require an idempotency key.

Payment records are append-only. Corrections use the reversal endpoint, which
stores who reversed the record, when, why, and the reversal idempotency key.
Stripe and credits allocations cannot be reversed by this endpoint; they must
use their provider/ledger-specific refund workflow.
Paid amount, due amount, and payment status are recomputed transactionally from
non-reversed allocations. Payment management is rejected for drafts, void
documents, credit notes, cross-tenant records, and invoices outside the user's
location scope. The `invoices.payments.manage` permission is assigned to owner,
administrator, manager, and accountant built-in roles.

## Automation

The safe defaults are:

- create a paid-order draft: enabled;
- finalize automatically: disabled;
- email automatically: disabled.

Finalization requires creation, and sending requires both creation and
finalization. The server rejects impossible combinations. A paid order can be
fulfilled even if invoice creation or delivery fails; the ten-minute
reconciler retries independently. Historical orders without trustworthy line,
tax, and payment snapshots are marked `requiresReview` and are never finalized
automatically.

## Deployment

1. Back up MongoDB and run `npm run migration:invoices` from the release
   artifact before starting the application or synchronizing new indexes.
2. Resolve every reported duplicate/conflict, then run
   `npm run migration:invoices -- --apply` and rerun the dry run until
   `indexPrerequisitesSatisfied` is true.
3. Deploy/start the API and create or synchronize the new unique indexes.
4. Configure each tenant's legal identity, address, tax mode, numbering
   prefixes, bank details, and automation choices.
5. Confirm the MongoDB deployment supports transactions (replica set or
   sharded cluster).
6. Exercise Stripe and credits checkout in test mode, then confirm order,
   draft, PDF, finalization, email, and credit-note reconciliation.

## Deliberately deferred hardening

- Jurisdiction-specific tax validation, numbering retention, mandatory fields,
  and retention periods require legal review per market.
- Generated PDF bytes are rendered from immutable snapshots but are not yet
  archived with a content hash/WORM retention policy.
- The email lease prevents concurrent duplicate sends, but exactly-once email
  delivery across a provider-success/database-failure boundary requires a
  durable outbox/provider idempotency integration.
- Tax-exclusive checkout pricing requires updating every Stripe and credits
  amount path before it can be enabled.
- Payment refunds and payment-to-credit-note reconciliation are a separate
  ledger/Stripe refund feature.
