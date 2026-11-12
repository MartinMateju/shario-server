# Membership V1 migration

This migration changes plan identity/versioning and adds unique open-membership,
ledger and Stripe-event indexes. Do not let the new application process start
against legacy data before conflicts are repaired.

## Safe rollout order

1. Take and verify a database backup.
2. Put membership writes in maintenance mode and stop every old API/worker
   process that can create or update membership plans/assignments.
3. Run the migration in dry-run mode from the new release artifact:
   `npm run migration:memberships-v1`.
4. Review counts, especially `openConflictsClosed`, `ledgerBalances`,
   `legacyStripeIdsForReview`, `invalidPlanPrices`,
   `invalidSelectedLocationScopes`, `unresolvedMembershipPlans` and
   `preflightBlockers`. Dry-run constructs the would-be plan-version IDs and
   pointers in memory, so its membership-conflict decisions and ledger count are
   the exact operations apply will use. `invalidPlanPrices` includes unsupported
   or missing currencies, invalid currency precision and every price that does
   not produce a positive integer minor-unit amount (including zero-price legacy
   plans). `invalidSelectedLocationScopes` distinguishes missing/invalid IDs,
   deleted locations and locations owned by a different tenant. The report
   includes exact plan, membership, tenant, user and subscription IDs plus exact
   open-membership conflicts.
5. Remediate every `preflightBlockers` record and rerun dry-run until the count is
   zero. Do not use a placeholder currency, positive price or location merely to
   bypass migration: these values become immutable published snapshots and
   customer billing terms. Investigate all legacy Stripe IDs; the script
   preserves them only in a review field and never treats them as
   connected-account IDs.
6. Apply while writes remain stopped:
   `npm run migration:memberships-v1 -- --apply`.
   Apply completes the entire preflight before its first write and refuses any
   invalid price, selected-location scope or unresolved membership plan/version.
   It also refuses to start when unmapped legacy Stripe IDs exist. Operations
   must first determine in Stripe whether each subscription is a platform charge
   or belongs to a tenant connected account, then cancel it or recreate/map it
   under the correct connected account. Only after recording that review may an
   operator explicitly acknowledge quarantine with
   `-- --apply --allow-unmapped-legacy-stripe`; those quarantined IDs are not
   controllable by the V1 cancellation/reconciliation code.
7. Verify the new plan-version pointers and run `syncIndexes()`/the normal
   controlled index deployment. In particular, confirm the partial unique
   `{tenant,user,isOpen}` index and remove the legacy unique `{tenant,name}` plan
   index. Mongoose `autoIndex` must not be allowed to race step 6.
8. Start/deploy the new backend, configure the complete Connect event list from
   `docs/stripe-connect.md`, run smoke tests, then deploy the frontend.
9. Leave writes in maintenance mode until a test publish, manual assignment,
   direct connected-account Checkout, cancellation and invoice download pass.

The command is idempotent at the document/key level, but a backup is still
required. It does not delete legacy fields, making rollback inspection possible.
