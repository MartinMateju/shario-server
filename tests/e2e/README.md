# Browser-test backend

Start a disposable Redis service on `127.0.0.1:6379` first, then the deterministic API fixture server. Database **15** must be reserved exclusively for this harness: startup and every reset clear that database. The harness forces the loopback URL, checks the connected database and test-mode guards, verifies Redis connectivity, and never clears database 0 or uses `FLUSHALL`.

```bash
npm run test:e2e:server
```

It listens on port `4001`, starts a one-node MongoDB replica set, disables
BullMQ connections and external delivery, then seeds:

- `studio-alpha` (published) and `studio-beta` (draft)
- `owner@studio-alpha.test`
- `viewer@studio-alpha.test`
- `customer@studio-alpha.test`
- `booking-customer@studio-alpha.test` with EUR 500 studio credit
- `owner@studio-beta.test`
- one primary location and workshop product per workspace
- an Alpha Open Studio product priced at EUR 25 per 30-minute block for the booking/payment/cancellation flow
- Alpha's required activity selection offers `MODELLING_GLAZING` with capacity 12
- active Studio Plus subscriptions and completed onboarding

Every account uses password `Playwright!123`.

Playwright can restore the baseline before each serial specification:

```http
POST http://127.0.0.1:4311/__e2e/reset
x-e2e-key: shario-e2e-local-key
```

The response is the fixture manifest, including stable tenant, user, location,
and product IDs. Concurrent reset requests are serialized. Before clearing MongoDB and Redis database 15, the harness blocks new API requests and waits for admitted handlers to finish (including handlers whose browser disconnected). A 30-second drain timeout refuses the reset instead of clearing data under active writes. The control route
cannot mount unless both `NODE_ENV=test` and `E2E_TEST_MODE=true`.
`E2E_TEST_KEY` may override the displayed local key, but it must have the same
value in the backend and Playwright processes. The API binds only to
`127.0.0.1`.

The staff-reschedule smoke explicitly drains its persisted booking notice with
`POST /__e2e/booking-lifecycle-delivery`, the same control key, and JSON
`{"bookingId":"..."}`. This route accepts only the fixed Alpha paid booking
fixture and runs the real claim and lifecycle processor. It requires the client
Postmark stub at exactly `http://127.0.0.1:4100`, its fake
`e2e-postmark-system-server-token`, and `POSTMARK_FROM_DOMAIN=notify.shario.io`;
there is no production-provider fallback. A fake managed sender is seeded only
when this control is used. The response contains `bookingId` and
`logs: [{id,emailType,status,providerMessageId}]`. Repeating it leaves sent or
ambiguous notices unclaimed. Browser assertions inspect the stub's captured
Postmark payload and message count; these notices do not use SMTP/Mailpit.
The awaited control request participates in the normal fixture-reset barrier.

The default in-memory MongoDB needs a compatible `mongod` binary. If that is
not available in the execution environment, copy `.env.e2e.example` to
`.env.e2e` and point `E2E_MONGO_URI` at a disposable MongoDB replica-set
database whose name contains a standalone `e2e` or `test` segment. External
MongoDB also requires the explicit `E2E_ALLOW_DATABASE_RESET=true`
acknowledgement; the server fails before connecting without it.
