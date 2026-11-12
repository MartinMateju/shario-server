# Invoice foundation migration

`npm run migration:invoices` is dry-run by default. It classifies existing
orders as trusted only when line arithmetic, gross total, and (for paid orders)
payment allocations agree. It does not invent historical tax or price facts.

Orders without a trustworthy snapshot receive `legacyOrder=true` in apply
mode. Invoices created from them remain drafts with `requiresReview=true` until
an authorized user replaces the lines and reviews payment details. Missing
customer email is backfilled only from a user belonging to the same tenant.
Existing invoice payment allocations also receive stable identifiers and
missing audit defaults so they can be addressed safely by the reversal API.

The dry run is also a required preflight for tenant-global invoice numbering.
It reports duplicate `(tenant, number)` and `(tenant, series, sequence)` groups,
and safely plans missing series/sequence backfills only when the stored number
has an unambiguous `<series>-<digits>` form and the target pair is unused.
Apply mode refuses numbering backfills while duplicate groups exist and exits
non-zero until every reported duplicate/conflict has been resolved. Do not run
Mongoose `syncIndexes()` or create the new invoice unique indexes before the
report says `indexPrerequisitesSatisfied: true`.

Issued documents with a linked customer account are audited against that
tenant customer's name, email, and phone. On a mismatch, apply mode detaches
only `customerUser`, quarantining the document from customer-portal `/mine`
queries. It deliberately does not rewrite the immutable legal snapshot.

After reviewing the dry-run counts:

```sh
npm run migration:invoices -- --apply
```

The operation is idempotent and reports scanned, trusted, legacy-classified,
email-backfilled, numbering-preflight/backfill, and unsafe-link audit counts.
Back up the database first, run the dry run, resolve duplicate samples, apply,
then rerun the dry run before synchronizing indexes.
