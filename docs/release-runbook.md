# Paired release and code rollback

This is an operator procedure, not evidence that a deployment or rollback was performed. Database restoration, backup verification and Atlas administration are outside this procedure. Preserve committed financial and delivery records through any code rollback.

## Record and validate the release

Record the operator, UTC time, exact client/server commit SHAs, CI URLs, deployment URLs and previous compatible client/server deployment IDs in the release record. Branch names and a green run for an older source revision are insufficient. If a merge changes runtime code, validate that resulting revision before promotion.

Evidence snapshot for the 2026-10-21 readiness candidate:

| Evidence | Exact revision | Observed result |
| --- | --- | --- |
| [Full server regression](https://github.com/MartinMateju/shario-server/actions/runs/39653372041) | Server `7745d262bd4600adfd06e207c46fbd55da2a1194` | Passed production typecheck and coverage: 7,335 tests passed / 2 skipped; 667 files passed / 2 skipped. |
| [Latest candidate critical CI](https://github.com/MartinMateju/shario-server/actions/runs/39655188280) | Server `e472bcbb77eecc9306c46f8e1b0aad00df40017a` | Running when this record was written; require success. Changes since the tested server above are harness, fixture and audit documentation only. |
| [Paired release smoke](https://github.com/MartinMateju/shario-client/actions/runs/39655178769) | Client `816d25de16558ed0b028c13a9eee82a06176027f`; server `e472bcbb77eecc9306c46f8e1b0aad00df40017a` | Running when this record was written; require success and retain `release-smoke-revisions.txt` plus Playwright results. |

Update this record for later commits and runs; these rows do not certify a newer revision or its production deployment. The [operations audit](production-readiness-audit-2026-10-21.md) records the earlier live revisions and saved deployment settings separately.

1. Review the client/API contract and migration/index changes against the current production revision. Identify additive fields, startup index checks, changed unique constraints and queue payload formats. Review applicable [product-location migration constraints](migrations/product-locations.md), [product kinds](migrations/product-kinds-v2.md), [Stripe Connect](stripe-connect.md) and voucher migration notes before applying anything. Inspect the relevant migration's plan/dry-run and approve its exact changes separately; do not run every migration or drop/rebuild indexes as routine deployment preparation.
2. Require successful client CI, server critical tests/build, relevant full regression, and the paired release smoke for the intended source pair. Keep Render **After CI Checks Pass** and Vercel **Release ready: Blocking** enabled; inspect actual check conclusions, because skipped/neutral checks are not evidence that a required test executed.
3. Run the paired browser smoke using the client's `Release smoke` workflow with `server_ref` pinned to the full server SHA. It uses an isolated database and local provider substitutes. Verify registration/sender setup, tenant isolation, paid studio-credit booking, persisted debit, failed cancellation without success UI, confirmed cancellation with one credit restoration, and repeated cancellation without another refund. Server regression must also pass signed payment settlement/replay and cancellation rollback tests. A real Stripe test-mode or provider-delivery check, if needed, belongs in the designated test environment; these fixtures do not establish real-provider delivery.

## Deploy and verify

1. Deploy the backward-compatible server first. Verify the intended SHA is **Live** for the API, communication email worker, communication scheduler and data import worker, with no failed/pending replacement deployment. Record each deployment URL. If the change cannot support old and new clients during rollout, stop and prepare an explicit migration/traffic plan instead of overlapping incompatible releases.
2. On the deployed API's configured public origin, read `/health` and `/ready`: expect HTTP 200 with `status: ok` and `status: ready` respectively. A 503 from `/ready` blocks client promotion; inspect Mongo connectivity and startup/index failures. Confirm workers connected to Mongo, the email/import workers are running, and scheduler checks continue. Record queue counts/oldest eligible age and heartbeat/last-success evidence when available; worker startup alone does not establish queue health.
3. Promote the matching client revision after backend verification. Record the Vercel deployment and served commit. Check the public catalog, customer sign-in and existing booking/credit views without creating live charges or customer messages. Run mutation checks only against designated test data/environment with approved provider mode.
4. Recheck API readiness, API/worker revisions, scheduler activity, queue failures/age and sustained HTTP/provider errors after rollout. A passing test run, successful deployment and healthy dependency are distinct evidence. Missing queue or alert evidence remains an explicit operational limitation, not a green check.

## Triage duplicate or uncertain payment/delivery outcomes

- Identify the affected tenant, order/booking, checkout operation and provider Session/PaymentIntent/refund/event IDs in restricted incident records. Compare stored amount/currency, connected account and test/live mode with trusted provider state. An HTTP timeout, failed browser response or pending refund does not establish that no money moved.
- Inspect booking-intent `processing`/`manual_review`, checkout leases, webhook processing records, refund intents and credit/voucher ledger entries before retrying. Preserve original idempotency keys and purchased snapshots. Never clear an uncertain lease, delete event history, manufacture a new operation key or create a replacement charge/refund merely to obtain a success response. See [booking recovery](customer-booking.md) and [refund reconciliation](voucher-redemption-management.md).
- Inspect notification locks/logs, provider acceptance IDs and recovery records before resending. Preserve sent/unknown/ambiguous states. Use the narrowly scoped, reviewed [confirmation recovery procedure](order-confirmation-recovery.md) only for its documented cases; do not reset all failed messages or replay accepted deliveries. Provider acceptance is distinct from inbox delivery.
- If correctness is in doubt, contain new affected writes using an established operational control and retain safe webhook/reconciliation processing. Assign a named incident owner; reconcile evidence and document the approved corrective action before a retry.

## Roll back compatible code

1. Select the previously recorded compatible client/server revisions and compare them against the schema, indexes, financial events and queue payloads now present. A previous release is not automatically rollback-safe. In particular, do not restart globally scoped product code after location-specific unique constraints and offerings exist.
2. Restore the compatible frontend first when reversing a backend contract upgrade, then the API and workers as the reviewed compatible group. Keep affected writes contained while compatibility is unresolved. If old code cannot safely read current records or preserve payment/refund/delivery idempotency, use a forward fix rather than a forced rollback.
3. Roll back application artifacts only. Do not reverse credit/voucher ledger entries, erase committed bookings/orders/refund intents, remove additive schema fields, drop indexes, delete webhook event/idempotency records, or reset notification/delivery history to make old code run. Do not perform a database restore as part of this procedure.
4. Verify deployed revisions, `/health`, `/ready`, worker/scheduler activity and affected read paths again. Reconcile in-flight payments/refunds and accepted messages using their original identities; record the outcome and unresolved items before resuming affected writes.
