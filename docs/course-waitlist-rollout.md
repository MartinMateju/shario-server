# Course waitlist rollout

Course waitlists are opt-in per Class session. Existing sessions without a
`waitlistConfig` remain disabled even after product defaults are changed.

Deploy the server before the companion client. Keep every session waitlist
disabled until both versions are live and the server-side checks below pass.

Deployment order:

1. Set a stable, randomly generated `WAITLIST_TOKEN_PEPPER` of at least 32
   characters in every API and worker environment. Do not reuse or rotate it
   with `JWT_SECRET`; rotating it invalidates outstanding waitlist links.
2. Deploy the server with waitlists still disabled.
3. Run `npm run indexes:waitlist:plan` against each database and review the
   proposed additive indexes. Resolve any pre-existing duplicate-key data
   before continuing.
4. Run `npm run indexes:waitlist` against each database. The apply command is
   additive and idempotent.
5. Confirm the minute email worker and expiry/capacity reconciliation jobs are
   healthy.
6. Confirm connected-account delivery for checkout completion and expiry plus
   `refund.updated` and `refund.failed` events.
7. Deploy the companion client.
8. Enable waitlists only on selected future Class sessions.

Rollback is to disable new joins while leaving the API and workers running so
existing customers can manage, pay, or withdraw and outstanding payment
reservations can settle safely.
