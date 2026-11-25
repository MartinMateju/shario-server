# Customer segmentation in Reports

The customer table and CSV use the same tenant, studio, permission, date and numeric predicates. Financial and cancellation predicates are evaluated before counting or paging. Ordinary pages enrich only the returned rows. Explicit filtered scans and exports use batches of 100 customer identities; no provider API is called.

## Financial filters

Input amounts are workspace-currency major units; response amounts and CSV amount columns are integer minor units. Money is cash paid on the original payment date, reduced by confirmed external refunds recorded as of the response timestamp. Later refunds can change an earlier period. Stored-value purchases count once; later credit/voucher redemption does not create cash again. Pending or unreliable financial evidence is unknown, not zero.

All-workspace spending requires complete financial visibility. A selected or restricted studio shows only receipts with reliable immutable studio attribution; locationless voucher purchases and membership invoices are excluded and disclosed in metadata. Current wallet balance is independent of the spending dates and requires full-location credit visibility. Membership allowances and free hours are not wallet money.

## Cancellation history

New Open Studio and paid course participant cancellations record an immutable operation event in the same transaction as cancellation, refund and durable notification. Failed transactions leave no event. The ID fences duplicate attempts. Class cancellation IDs include order, session and saved operation ordinal; cancellation counts are distinct customer/booking pairs, not seats.

Older course cancellation snapshots are dated by their saved operation timestamp. No timestamp is inferred from a booking start, updatedAt, email delivery or provider settlement. Legacy cancelled Open Studio bookings without an event, and malformed class history, make that customer's exact count unknown. The API also returns the recorded lower bound. A minimum-only filter can match that lower bound; any maximum requires complete history. General coverage metadata remains explicitly incomplete. No historical data is backfilled.

The staff actor classification comes from resolved workspace access at the staff cancellation entrypoint; customer self-service records customer initiation. Course participant cancellation remains staff-only. This change does not add whole-class cancellation or alter refund policies.

## Activity and permissions

Inactive days means time since the last started confirmed visit in the selected studio scope; account creation is used only when no visit is recorded. Future bookings do not make a customer recently active. The 90-day positive-wallet suggestion scans only positive-wallet identities using grouped booking-date queries and no payment/cancellation history enrichment. Unknown relevant balances/dates make the suggestion unavailable.

Base access requires reports.view and customers.view; CSV additionally requires reports.export. Each metric domain is separately gated. Disabled or denied metrics are null, and using their numeric filters is rejected. Customer IDs and guest purchase identities remain tenant-bound; contact email is never an identity merge key.

## Additive index rollout

The new bookingcancellationevents collection uses native unique _id for operation idempotency. Two non-unique schema indexes support reads:

- booking_cancellation_customer_period: tenant, customer, occurredAt, location
- booking_cancellation_identity: tenant, booking, customer

Normal Mongoose model initialization creates the collection/indexes when enabled. If autoIndex is disabled, create only these two declared indexes as an additive deployment operation and verify their names/keys. Do not use syncIndexes or rebuild/drop existing indexes. No production migration or historical event backfill is needed.

CSV is streamed with backpressure; a failed traversal destroys the response. Clients must finish the entire response successfully before offering a file, and must not publish partial CSV as a successful export.
