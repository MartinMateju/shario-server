# Voucher foundation (step 2)

Skab owns voucher validity, issued entitlements, revocation and history. Stripe
collects purchase payments and reports payment/refund outcomes. This change keeps
the existing full-value conversion of a voucher into customer account credits.
The visual designer and direct voucher-plus-card booking checkout are later steps.

## Issued terms and validity

- New offerings default to 12 calendar months. The editor offers 3, 6, 8 and 12
  months, custom whole months (1–120), a fixed calendar date, or no expiry.
- Expiry is calculated through the end of the expiry date in the tenant timezone,
  with month-end clamping. Purchase validity starts at the confirmed payment event;
  manual issuance starts when the code is issued.
- Purchase orders retain price, currency, title, PDF template, validity, timezone
  and locale. Codes retain their original value and terms. Subsequent edits and
  archival do not change already-sold terms or prevent paid fulfillment.
- Existing codes/orders without validity snapshots retain their previous expiry;
  the new default is not retroactively imposed.
- Fixed-date purchases stop 35 minutes before expiry to allow the 30-minute card
  checkout window. A late confirmed payment is held for manual review without
  delivering an already-expired code.
- Experience entitlements and reservation/commit/release/reversal services are
  internal groundwork. Experience sales and direct booking redemption remain
  unavailable until their booking adapter is implemented.

## Offering limits and deletion

`voucherQuotaVersion: 1` is assigned explicitly when provisioning new tenants.
Those tenants may publish 3 Starter, 10 Professional, 25 Studio Plus or unlimited
Enterprise voucher offerings. This counts active offerings, not individual issued
codes. Tenants without the marker keep their existing unlimited allowance. Stripe
subscription prices and existing plan versions are unchanged.

Publication, activation, imports, rollback, purchase creation and issuance use a
shared tenant mutation lock in MongoDB transactions. Concurrent requests cannot
claim the same final offering slot. A downgrade retains existing offerings but
blocks additional publication above the new cap.

Finite, unexpired issued codes prevent offering deletion. Archiving remains
available. Perpetual codes require the exact text:

`I agree and I confirm that it can be deleted`

This deletes the offering only. Issued codes, original value/name snapshots,
purchase history and required assets remain. Pending purchases or delivery also
block deletion. Full refunds that have finished reconciliation do not count as
pending purchases. Code revocation is a separate audited operation.

## Refunds and delivery

Connected-account `charge.refunded` events revoke unused codes after a full refund.
Partial refunds, used codes and payment reservations enter manual review; their
remaining entitlement is blocked and existing account credits are preserved.
Failed/canceled refund updates also enter durable review, without automatically
reissuing value. Duplicate and older cumulative events cannot repeat revocation
or clear a failure review flag. Refunds arriving before purchase confirmation are
bound to the saved Checkout Session as well as the tenant, account and payment.

This reconciliation observes refunds; it does not initiate a Stripe refund.
Historical platform-account purchases require manual voucher revocation/review.
Used/refund-held liabilities require a reviewed reconciliation; this step does
not expose a bulk credit clawback or automatic reactivation control.

Emails use tenant branding and customized layout with Skab defaults, purchased
locale and actual expiry. Admin notifications use eligible verified tenant
owners/admins and their preferences. Customer delivery runs first, and skipped
admin delivery is recorded separately from successful sends. Retries preserve
issued codes and completed delivery channels.

Delivery rechecks refund state after rendering. Email sending and its sent marker
are not one atomic operation: a crash after SMTP acceptance can still cause a
duplicate email. Durable queued delivery is the later email stage. Existing PDF
artwork is retained; its static printed text must be compatible with the offering
terms until the designer provides dynamic expiry fields.

## Deployment gates

1. Use the repository's Node 22 runtime and a MongoDB replica set (transactions
   are required).
2. With the intended database configured through `MONGO_URI`, inspect the additive
   index plan: `npm run indexes:vouchers:plan`.
3. Resolve any reported duplicate IDs or conflicting index definitions, then run
   `npm run indexes:vouchers`. Rerun the plan and require `indexesReady: true`
   before enabling writes. The script never drops indexes or rewrites data.
4. Ensure the existing connected-account webhook endpoint subscribes to
   `charge.refunded`, `refund.updated`, and `refund.failed`, in addition to its
   checkout events. Keep existing signature verification configured.
5. Run both new MongoDB integration suites in CI against a working replica set:
   `tests/integration/coupon/voucher-lifecycle.test.ts` and
   `tests/integration/product/voucher-offering.concurrent.test.ts`.
6. Deploy the server before the companion client changes. Existing tenants need
   no quota migration; do not bulk assign the new quota marker.

The schema's existing nonempty Stripe Session partial-index predicate now uses
MongoDB-supported `$gt: ""` instead of `$ne: ""`. The additive maintenance script
does not modify that existing index; inspect its deployed definition separately
if the database reports an index-options conflict.

Local unit/component verification exercises service decisions and UI behavior.
The development environment could not start MongoDB (`open: Operation not
permitted`), so the new database concurrency suites remain a required CI gate.
