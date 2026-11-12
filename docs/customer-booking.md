# Customer booking flow

The public booking journey is a two-stage, tenant-scoped flow:

1. An anonymous visitor selects a product, location/session, time and guest
   count. `POST /public/tenants/:tenantSlug/booking-intents` validates the
   product against the published tenant, current module entitlements,
   availability and server-side pricing.
2. The API returns a signed, 30-minute booking-intent token. The browser may
   carry this token through sign-in, registration and email verification, but
   must not treat the token as proof of price or capacity.
3. A verified end-customer restores the selection with
   `GET /booking-intents/:token`. The API atomically binds the intent to that
   customer and recalculates availability, pricing, membership discounts and
   payment options.
4. The customer submits `POST /booking-intents/:token/checkout` with an
   `Idempotency-Key` header, accepted terms and a server-offered payment
   method. The server recalculates the quote immediately before fulfillment.

Tenant staff and platform users cannot use the customer checkout routes.
Booking ownership is enforced from the database, not from browser-provided
user IDs. Customer booking and confirmation reads are available at
`/bookings/mine` and `/orders/mine/:orderId/confirmation`.

Credentialed authentication is also origin-bound. A refresh token may be
rotated only from Skab's trusted platform UI, the exact tenant subdomain, or
an active custom domain recorded on that same tenant. CORS permission for a
different active tenant domain is not sufficient.

## Idempotency and recovery

Each intent has a persisted random identifier, customer claim and checkout
lease. Repeating a completed request with the same idempotency key returns the
stored response. Reusing a key with different input is rejected, and a
completed intent cannot produce a second order.

Ordinary failures that were fully rolled back release the checkout lease and
may be retried. A failed rollback, or an uncertain failure after fulfillment,
moves the intent to `manual_review`; automatic retries are then rejected to
avoid duplicate charges, credit redemptions or bookings.

An expired `processing` lease is also treated as uncertain and moves to
`manual_review`. It is never taken over automatically: a process could have
created a live Stripe Checkout Session immediately before it disappeared.

Money-credit debits and membership entitlement redemptions use their own
idempotency records and compensating operations. Capacity is rechecked inside
the fulfillment transaction. Card sessions use the order processing lease in
the Stripe webhook.

## Confirmation delivery

All paid orders—card, money credits, membership credits and free checkouts—
use the existing paid-order notification job. It runs every two minutes and
uses an atomic order lock plus a retry log. Checkout code must not call a
second booking-level confirmation sender.

## Configuration

Set `BOOKING_INTENT_SECRET` to a server-only random value of at least 32
characters. It may fall back to `ACCESS_TOKEN_SECRET` for compatibility, but
production deployments should use separate keys.
