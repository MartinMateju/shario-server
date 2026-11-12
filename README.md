# Shario server

Independent Express/TypeScript API for Shario shared spaces. It reuses Skab's generic multi-tenant services and removes pottery-specific endpoints, jobs and workflows.

## Local setup

Requires Node 22 and Docker Compose for the standard local database setup. Place `shario-client` next to this repository, install dependencies in both, then run:

```sh
npm ci
npm run setup:local
npm run infra:up
npm run dev
```

Start `npm run dev` in `shario-client` separately. The API uses port **4311**, the frontend **4310**, MongoDB **27028** with the `shario` database, and Redis **6381**. Compose has its own `shario-local` project and volumes. MongoDB runs as a replica set because registration and bookings use transactions.

`setup:local` creates fresh signing/encryption keys and shares only the required server-side auth-proxy key with the frontend. Files are ignored by Git and existing configuration is never overwritten. Stripe, Postmark, SMTP, R2, OAuth and AI values must be supplied for the corresponding integrations. They are not copied from Skab. The ordinary server deliberately validates provider configuration; use the isolated E2E harness for a provider-free test environment.

`npm run dev` starts the API and import worker. Production worker commands for communication emails, automation scheduling and data imports are listed in `package.json` and should be supervised separately.

## Verification

```sh
npm run typecheck:production
npm run build
npm run test:unit
npm run test:integration
```

For browser tests, `npm run test:e2e:server` starts a temporary MongoDB replica set, seeds fictional shared spaces and mocks Stripe/R2. It requires dedicated Redis on `127.0.0.1:6381`; its reset endpoint is restricted to test mode, a test key, loopback infrastructure and Redis database 15. The companion client contains the Playwright journeys. No live payments or emails are needed for the basic booking/isolation checks.

## Independent services

Redis keys and BullMQ queues use a `shario` prefix. Tenant billing lookup keys, mail identity and platform domains use Shario. Configure separate provider resources and webhook secrets for this application. Do not reuse Skab's database, signing keys, storage bucket, webhook destinations or live Stripe price IDs.

Native invoice management remains behind `NATIVE_INVOICES_ENABLED`; enable the corresponding client switch together. Commerce imports retain their guarded index/migration rollout. Generic data imports and migrations remain available. The old tenant-specific pottery migration and broken legacy global seed/delete scripts are excluded.

See [fork scope and provenance](docs/SHARIO-FORK.md) for retained and removed features. No production deployment or DNS change is included.
