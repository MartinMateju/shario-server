# Product kinds V2 migration

Product kinds V2 introduces one tenant-facing taxonomy:

- `open-studio`
- `class`
- `membership`
- `voucher`
- `private-studio`

The rollout is additive. The migration writes `kind`,
`kindContractVersion: 2`, and—where it can be inferred safely—the fixed
Open Studio `bookingMode`. It never changes or removes the legacy `type`
field. This lets older application versions and workers continue to operate
during a staged deployment.

Open Studio privacy is a booking mode, not a product kind. Both public and
private offers have `kind: "open-studio"`; each offer persists one fixed mode
and party size never changes it. `private-studio` is reserved for internal
calendar blocks and is neither customer-bookable nor sellable.

## Automatic mappings

| Legacy `type`                                        | V2 `kind`        | Backfilled `bookingMode` |
| ---------------------------------------------------- | ---------------- | ------------------------ |
| `workshop`, `open-studio`                            | `open-studio`    | `public`                 |
| `public-workshop`                                    | `open-studio`    | `public`                 |
| `private-workshop`                                   | `open-studio`    | `private`                |
| `course`, `public-course`, `private-course`, `class` | `class`          | n/a                      |
| `coupon`, `gift-card`, `voucher`                     | `voucher`        | n/a                      |
| `blocker`, `private-studio`                          | `private-studio` | n/a                      |

The script reports these records without changing them:

- `service`: usage is ambiguous and must be classified from tenant data.
- Product records with `membership` or `credit-pack`: the authoritative V2
  aggregate is `MembershipPlan`; do not relabel a generic Product blindly.
- `physical-product`: retail is outside the V2 tenant taxonomy and must be
  retired or handled by an approved business-data procedure.
- unknown types, non-canonical existing kinds, `type`/`kind` conflicts, and
  missing, invalid, or misplaced Open Studio modes.
- operational `booking-addon`, `guest-increase`, `prolong`, and `system`
  records. These are system-owned and intentionally remain outside the
  tenant-facing taxonomy.

## Deployment procedure

1. Back up the `products` and membership-plan collections and record their
   document counts.
2. Deploy the server version that reads both `kind` and legacy `type`. Keep
   old clients and workers compatible with `type` during the rollout.
3. Run a dry-run and retain its JSON report:

   ```sh
   npm run migration:product-kinds-v2
   ```

4. Resolve every `manualReview` record. For an ambiguous timed service, set
   its canonical kind and Open Studio mode only after checking tenant
   intent. Move generic membership/credit-pack products through the supported
   MembershipPlan migration. Retire unsupported retail records according to
   the business-data retention policy.
5. Use the strict dry-run in deployment automation. A non-empty
   `manualReview` list exits unsuccessfully:

   ```sh
   npm run migration:product-kinds-v2 -- --fail-on-manual-review
   ```

6. Apply only after the strict preflight passes:

   ```sh
   npm run migration:product-kinds-v2 -- --apply --fail-on-manual-review
   ```

   The strict flag is a preflight gate: the script performs no writes if it
   finds a manual-review record. Updates also require the legacy type to be
   unchanged and the target `kind` to still be empty, protecting concurrent
   edits.

7. Run the dry-run again. `updateCandidates` and `concurrentSkips` should both
   be zero. Investigate any non-zero concurrent skip instead of rerunning
   blindly.
8. Deploy the V2 client, then retire old clients and workers. Remove the
   legacy `type` field only in a later, separately reviewed migration.

The migration is idempotent: matching V2 records are reported as
`alreadyMigrated`, and an existing valid Open Studio mode is never
overwritten.

## Rollback

The immediate application rollback is to redeploy the previous application
version. It remains functional because this migration preserves `type`.
Restore from the pre-migration backup if the additive V2 fields themselves
must be reverted; do not perform a broad field deletion without verifying the
exact `kindContractVersion: 2` targets and retaining the migration report.
