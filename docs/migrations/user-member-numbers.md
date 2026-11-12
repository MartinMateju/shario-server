# User member-number migration

`memberNumber` is the numeric source of truth for the short ID a studio member
writes on pottery. It is unique and monotonically allocated within a tenant.
APIs store and return the number (for example, `17`); customer-facing surfaces
present it canonically as `#17`. The legacy `customId` remains unchanged only
for compatibility with old QR payloads, integrations, guest claiming, and
historic snapshots.

Digit-only legacy IDs are existing physical identities. A unique value is
preserved during backfill: for example, `customId: "001675"` receives
`memberNumber: 1675`. The allocation floor includes both persisted member
numbers and every positive safe-integer digit-only legacy ID, so newly assigned
numbers start above all of them. The counter is never moved backwards and an
assigned number is never recycled. Gaps after failed requests or a customer
renumbering are therefore expected and safe.

## Automatic rollout and invariants

New real users receive a number when they are created. Login, token refresh,
current-account reads, customer reads/lists, and pottery registration also run
an idempotent lazy assignment for pre-rollout records. Concurrent calls use the
same tenant counter and the tenant-scoped unique index, so they converge on one
persisted number. Inactive generated `G-…` guest placeholders remain
unnumbered until claimed. Archived records from rolled-back imports also remain
unnumbered.

After initial assignment, normal document saves cannot change `memberNumber`.
The only supported reassignment path is the explicit customer-import conflict
flow described below.

## Preserving IDs during customer import

An import can request preservation of an incoming numeric ID. A free ID is
assigned to the imported customer and advances the counter's high-water mark.
For a collision, the normal safe choice is to allocate the imported customer a
new number. If an operator explicitly confirms displacement, the current
customer receives a newly allocated number before the imported customer takes
the requested one.

Every reassignment uses a transaction-aware compare-and-swap and appends the
old value to private `memberNumberHistory` with the replacement time, reason,
import session, and actor. Existing pottery maker-code snapshots are retained
so physical pieces remain traceable. Staff search accepts both `N` and `#N`
and can find indexed historical values; exact lookup always prefers the current
owner of a number. An explicit non-customer tenant role, a legacy
admin/moderator role, or any workspace membership protects an account from
import displacement; a customer import can never renumber a team account.

## Optional manual preflight and backfill

The lazy path is sufficient for normal deployment. The all-tenant migration is
an optional rollout tool when a studio wants to inspect conflicts up front and
preserve every unambiguous digit-only legacy ID in one controlled operation.

1. Start a short user-write maintenance window, deploy the additive schema,
   counter, and serializer changes, and drain every old API instance before
   continuing. This prevents an old process from creating an unnumbered user
   after the migration has already inspected that tenant.
2. Preview the backfill:

   ```bash
   npm run migration:user-member-numbers
   ```

   Review `totals.conflicts` and every tenant's `conflicts` list. It must be
   `0` before apply. Numeric identities are normalized, so `952` and `0952`
   conflict with each other, as does one user's numeric `customId` with another
   user's matching `memberNumber`. Each conflict reports the number, user IDs,
   stored IDs, and identity source. Resolve ownership explicitly before
   continuing; the migration will not guess or rewrite a legacy ID.

3. Run the apply phase while the user-write maintenance window remains active:

   ```bash
   npm run migration:user-member-numbers -- --apply
   ```

   Apply runs the same all-tenant preflight first and refuses before migration
   writes if any conflict remains. Unique numeric legacy IDs are adopted, then
   all other eligible users are allocated above the combined high-water mark.

4. Run the preview again. `totals.eligible` must be `0`; `assigned` is `0` on
   the second run. For every tenant, the counter must be at least the highest
   assigned member number.
5. Deploy the client only after the server rollout is complete. It displays
   `memberNumber` as `#N` and never exposes `customId` as a customer-facing
   fallback; a record that is intentionally still unnumbered displays `—`.
   Then reopen user writes.

The migration is idempotent. It never rewrites existing numbers or legacy
custom IDs. A second successful apply assigns nothing. Inactive generated
`G-…` guest placeholders are skipped and receive a number only when claimed.
