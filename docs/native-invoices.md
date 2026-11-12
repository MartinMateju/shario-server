# Native invoice feature

Native Skab invoicing is disabled by default for the MVP. No invoice records,
numbering counters, customer links, or tenant settings are deleted or migrated.

The API switch is `NATIVE_INVOICES_ENABLED`. Only the value `true` enables the
feature; unset or `false` leaves it disabled. The frontend uses the matching
`NEXT_PUBLIC_NATIVE_INVOICES_ENABLED` switch.

While disabled, all native admin and customer invoice routes return HTTP 404
with `INVOICE_FEATURE_DISABLED`, including settings, PDFs, payments and credit
notes. Direct service operations are guarded too. Paid-order callbacks return
`disabled` without reading or updating invoice state, reconciliation does no
work, and its cron job is not registered. AI context and invoice practice steps
are unavailable. Historical records and unfinished practice sessions are kept.

Stripe checkout, payment fulfillment, customer receipts, Stripe membership
billing/history and Skab's own tenant-subscription billing keep their existing
behavior. Checkout still reads the existing tax settings and writes order price
snapshots; these are also needed for discounts and refunds. The switch does not
configure Stripe receipt email delivery.

To restore native invoicing, set `NATIVE_INVOICES_ENABLED=true` on the API and
`NEXT_PUBLIC_NATIVE_INVOICES_ENABLED=true` when building the frontend, then
restart/redeploy both. Review tenant automation settings first: retained paid
orders and existing automatic drafts may be picked up by reconciliation after
re-enabling. No data backfill or deletion is needed to disable the feature.
