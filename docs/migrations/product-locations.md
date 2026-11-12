# Location-specific studio products

Open Studio and Private Studio products now belong to exactly one location for new sales and reservations. The database field is `Product.location`; requests and DTOs use `locationId`. Classes, membership plans, vouchers, and operational add-ons retain their existing scope.

An assigned studio product cannot be moved. Duplicate it to another location to create an independently editable offering. Names are unique per business and location; nonstudio products keep a null location. Unassigned historical studio products remain editable by members with access to all locations, but are unavailable for new customer bookings. Product imports without location information also require this explicit assignment before new bookings.

## Historical records

The migration only adds `location` to existing product documents. It never changes product IDs, booking locations, bookings, orders, prices, payment records, or purchased line-item snapshots. Existing rescheduling, payment completion, and reservation add-ons continue to use the saved reservation. Experience vouchers cover classes, whose scope is unchanged. Product-restricted value vouchers retain their original eligible product IDs; independently created copies are not automatically eligible.

## Plan and review

The API now performs the name-index upgrade automatically after connecting to MongoDB and before accepting traffic. It creates and verifies the unique `{ tenant: 1, location: 1, name: 1 }` index, then removes only the obsolete full unique `{ tenant: 1, name: 1 }` index. This fixes cross-location name conflicts even when legacy location assignments are still pending. It does not assign locations or modify any product, booking, or order. Repeated and concurrent starts are supported; unexpected index definitions or a failed replacement build stop startup without dropping the old constraint. Other indexes remain unchanged.

The location-assignment migration below remains a separate, explicit operation. Its dry run stays read-only and does not trigger the startup index upgrade.

Run the migration with the target environment's normal `MONGO_URI`. Dry-run is the default:

```sh
npm run migration:product-locations -- --fail-on-manual-review
```

The report includes proposed assignments and reasons. It infers a location only when historical bookings and matching order lines agree on one active location, or when there is no history and the business has exactly one active location. It does not guess for products used at multiple locations, missing/foreign locations, or ambiguous unused products.

Supply reviewed assignments as JSON when needed:

```json
[
  {
    "tenantId": "111111111111111111111111",
    "productId": "222222222222222222222222",
    "locationId": "333333333333333333333333"
  }
]
```

```sh
npm run migration:product-locations -- --assignments product-locations.json --fail-on-manual-review
```

For a formerly shared product, choose the future location of the original and create independent copies at the other locations. Existing reservations at either location keep the original product reference and their saved location. Review outstanding product-restricted value vouchers before copying; retain the original product for their redemption. If customers were promised redemption at multiple locations, resolve that entitlement policy before cutover rather than silently rewriting issued voucher snapshots. Assignments are tenant-validated, cannot move an already assigned product, and must reference products in the selected scope.

## Release sequence

1. Review the dry-run and resolve assignments before release. Verify the database backup and rehearse on a copy.
2. Pause product writes and new bookings for the coordinated server/client cutover. Keep payment completion available where deployment infrastructure supports it.
3. Apply the reviewed backfill:

   ```sh
   npm run migration:product-locations -- --apply --assignments product-locations.json --fail-on-manual-review
   ```

4. Deploy the matching server and client changes, check both location catalogs, creation, checkout rejection for a mismatched location, and existing booking/order views. Resume writes after those checks.

The replacement unique index `{ tenant: 1, location: 1, name: 1 }` is created before removing the exact old `{ tenant: 1, name: 1 }` unique index. Other indexes are untouched. `--tenant-id <id>` limits product assignment only: indexes are collection-wide. Do not restart an old server build that declares the old unique index after independent same-name offerings have been created.

The command is idempotent and uses compare-and-set updates to avoid overwriting concurrent assignments or taxonomy changes. It reports concurrent skips as a failure requiring another dry-run. `--fail-on-manual-review` prevents all writes when any unresolved assignment remains. No production migration is run as part of creating the pull request.

## Rollback

Keep the additive location values and historical references. A code rollback to the old globally scoped catalog is not a safe automatic rollback once separate offerings exist; keep new booking writes paused and reconcile duplicates before restoring the old global uniqueness rule. Never delete historical products or rewrite existing orders to force a rollback.
