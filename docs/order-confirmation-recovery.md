# Controlled payment confirmation recovery

This operator command addresses the known SMTP outage (`connect ECONNREFUSED
127.0.0.1:1025`) and an explicitly selected paid pottery-piece order whose
confirmation was never created. It does not send email itself. Applying the
plan makes the selected orders eligible for the running confirmation worker,
which may send immediately after the transaction commits.

Deploy and verify the managed confirmation sender before applying recovery.
Do not enable historical orders, delete notification logs, reset all failed
rows, or invoke a broad payment/booking resend. The command requires an explicit
tenant and between 1 and 50 explicit order IDs; it has no all-orders option.
Use a read-only database credential for the planning step where available.

## Plan and review

Use the deployment's existing `MONGO_URI`; do not put credentials on the command
line. The compiled command is:

```sh
node dist/modules/order/scripts/recover-order-confirmations.js --tenant-id TENANT_OBJECT_ID --order-id ORDER_OBJECT_ID --order-id SECOND_ORDER_OBJECT_ID --piece-order-id PIECE_ORDER_OBJECT_ID
```

From source, replace `node dist/modules/order/scripts/recover-order-confirmations.js`
with `npx tsx src/modules/order/scripts/recover-order-confirmations.ts`.
Omit `--piece-order-id` unless that specific piece-payment confirmation is part
of the approved recovery. Repeating either ID option is supported. `--help`
does not connect to the database.

The default is **dry-run**, using native collection reads only: no indexes,
application workers, provider calls, or writes. JSON output includes the exact
IDs, tenant, payment date, masked recipient, payment method(s), amount in minor
units, currency, eligibility/rejection reason, counts, and `approvalToken`.
Review the dates and recipient masks, not just the eligible count. No complete
recipient addresses, provider payloads, or connection strings are printed.

The exhausted-failure lane requires exactly one `order_confirm` event, `FAILED`,
attempt 3, and the exact known loopback refusal error. The piece lane requires a
paid, processed, unrefunded piece checkout and no existing confirmation. Both
lanes reject legacy orders, unpaid/unprocessed orders, missing valid payment
dates/recipients, any sent/unknown/ambiguous/in-progress event or provider-start/
acceptance evidence, live notification locks, and any earlier recovery record.
Not-found IDs are rejected within the supplied tenant scope. Any rejected ID
blocks the entire apply; remove it only after reviewing why it was rejected.

## Apply the reviewed snapshot

Repeat the exact selection and append:

```sh
--apply --approve-plan THE_APPROVAL_TOKEN_FROM_DRY_RUN
```

The token covers the selected IDs, raw order snapshots, and resolved recipients.
If any reviewed source data changed, the command refuses the token and requires
a fresh dry-run. Each write also compares the full reviewed notification log and
source fields, tenant, payment state, recovery absence, and free lock. All writes
commit together in one MongoDB transaction; a concurrent claim/change rolls back
the complete batch. The database must support transactions, as production does.

The command stores one immutable recovery generation in `notificationRecovery`:
`id` (the plan hash), `requestedAt`, `expiresAt` (24 hours), `reason`, reviewed
recipient `to`, and the complete original confirmation entries in `previousEvents`.
It removes only those archived `order_confirm` entries from the active log and
preserves all other events. Financial state and payment timestamps do not change.
The worker pins the reviewed recipient, applies its usual retry/lease limits,
and uses the explicit recovery window to handle these older payments. A second
application cannot create another generation, even after the window expires.

## Verify without replaying

Inspect only the selected orders' recovery IDs and new active `order_confirm`
states. `SENT` records provider acceptance, not guaranteed inbox delivery; check
the managed provider's delivery/bounce status separately. Failed or ambiguous
outcomes require investigation rather than another reset. Do not clear the
recovery marker, replay accepted messages, or expand selection to legacy orders.
If apply reports an uncertain database failure, first inspect whether the exact
recovery ID committed; do not infer that no emails were released from the CLI
exit status. An existing recovery record blocks automatic reapplication.
