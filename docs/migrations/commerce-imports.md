# Membership, credit, and voucher import rollout

The Step 3 import routes and worker are fail-closed until both the rollout flag
and every required unique index are present. This prevents concurrent imports
from creating duplicate plans, memberships, credit allocations, products, or
issued vouchers while indexes are still building.

## Rollout order

1. Deploy the server with `DATA_IMPORT_COMMERCE_ENABLED` unset or set to
   `false`.
2. Run the index preflight. It is a dry run unless `--apply` is supplied:

   ```sh
   npm run migration:commerce-import-indexes
   npm run migration:commerce-import-indexes -- --apply
   ```

   The command checks every tenant-scoped key for duplicate groups before it
   creates anything. A conflict or a mismatched named index fails the command;
   resolve it explicitly and rerun. The migration never drops or rewrites an
   existing index.

3. Backfill immutable values for legacy issued vouchers. Review the dry-run
   output before applying it:

   ```sh
   npm run migration:coupon-value-snapshots
   npm run migration:coupon-value-snapshots -- --apply
   ```

   Invalid legacy vouchers remain blocked from import or redemption until they
   have an authoritative paid-order or product value snapshot.

4. Set `DATA_IMPORT_COMMERCE_ENABLED=true` on the API and data-import worker,
   then restart both processes. The runtime still verifies the named index
   definitions and returns a 503 instead of accepting work when they are not
   ready.
5. Deploy the matching client after the API and worker are ready.

Keep the existing `worker:data-imports` process running. Validation never
writes business records; execution is the only phase that posts entitlement or
credit-ledger mutations.
