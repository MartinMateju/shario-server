# Communication Automations Module

Production-ready TypeScript module for tenant-aware communication automations.

## Files

- `communication-automation.constants.ts`
- `communication-automation.types.ts`
- `communication-automation.schema.ts`
- `communication-automation.model.ts`
- `communication-automation.validators.ts`
- `communication-automation.queries.ts`
- `communication-automation.repository.ts`
- `communication-automation.service.ts`
- `communication-automation.utils.ts`
- `controllers/communication-automation.controller.ts`
- `routes/communication-automation.routes.ts`

## Runtime

Communication automations require two independent long-running processes in
addition to the API. Production commands run the compiled artifact produced by
`npm run build`:

```bash
npm run worker:communication-scheduler
npm run worker:communication-emails
```

Both workers need the same MongoDB and Redis connectivity as the API. The
scheduler materializes immutable, idempotent delivery logs; the email worker
enforces tenant state, sender readiness, consent, suppression, quiet hours and
source validity immediately before delivery.

Before starting these workers for the first time, run the idempotent index
migration once:

```bash
npm run migration:communication-email-idempotency
```

For local source-mode operation, use the corresponding `:dev` scripts.

Do not start automated delivery until that migration succeeds. It verifies the
replacement partial unique index before dropping the legacy index and is safe
to rerun.

Deploy the server and migration before the client. Keep the legacy course
reminder cron running: it is a conditional fallback and skips bookings already
owned by a ready automation or materialized automation delivery.

## Supported triggers

- After a customer's booking is confirmed (`afterBookingCreated`): the paid
  order's `paidAt` plus the offset, including purchases of existing classes.
  Each booking/order pair is sent only to that order's customer and revalidated
  before delivery. Only orders paid after activation are eligible; no historical
  backfill runs on activation. Rescheduling does not create another occurrence.
  The scheduler checks due events every minute by default; quiet hours can
  defer delivery further.
- Before a session starts and after a session ends (`beforeBooking` and
  `afterBooking`), including canonical and historical booking product tags.
  Existing `afterBooking` automations retain their end-of-session timing.
- After customer registration
- After pottery-piece registration
- One-time, daily, weekly and monthly sends

Firing-completion emails remain owned by the grouped firing workflow because it
also closes the firing and releases the kiln. Per-piece firing automations are
rejected to prevent duplicate or multiplied customer email.

## Operational notes

- Uses Zod for request validation.
- Uses tenant-aware database queries.
- Uses explicit imports; no root barrel `index.ts`.
- New automations are created as `waiting_to_activate` and inactive by default.
- Activation requires an active tenant-scoped sender with a successful SMTP
  test and complete localized content (inline or from an active, non-layout
  content template).
- Broadcast and registration automations must apply to all locations. Scoped
  managers can configure source-bound booking and pottery-item automations but
  cannot use a location label to send to the whole tenant audience.
- Production SMTP verifies TLS certificates. `EMAIL_ALLOW_SELF_SIGNED=true`
  relaxes verification only outside production.
- Deactivation cancels pending deliveries. Terminal delivery logs follow the
  tenant communication-retention policy, which redacts or deletes recipient
  data and message bodies after the configured period.
