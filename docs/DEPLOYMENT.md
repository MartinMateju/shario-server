# Portable Node deployment

This repository includes a Node 22 container for the existing persistent API and workers. It does not create hosting resources, configure providers, run migrations, or deploy anything. The existing API and four worker entrypoints are retained; scheduled work now uses Redis coordination to reduce duplicate execution during overlapping deployments.

The frontend can run on Vercel while this image runs on any host that supports persistent Linux containers and outbound MongoDB, Redis, HTTPS and email connections. The API accepts the existing large uploads; configure the host's reverse proxy to permit at least 41 MiB request bodies and suitable request timeouts.

## Build once, run five services

```sh
docker build --pull -t shario-server:RELEASE .
```

Use the same image and release for every service. Override the image command for workers; run Node directly so it receives termination signals.

| Service | Container command | Equivalent package command | Instances initially |
| --- | --- | --- | --- |
| API and scheduled jobs | `node dist/server.js` | `npm start` | 1 |
| Notification delivery | `node dist/workers/notification.worker.js` | `npm run worker:notifications` | 1 |
| Communication email delivery | `node dist/workers/communication-email.worker.js` | `npm run worker:communication-emails` | 1 |
| Communication automation scheduler | `node dist/workers/communication-automation-scheduler.worker.js` | `npm run worker:communication-scheduler` | 1 |
| Data imports | `node dist/workers/data-import.worker.js` | `npm run worker:data-imports` | 1 |

All four workers are needed to retain their features. `npm run dev` starts only the API and import worker; it is not a production process supervisor.

The API currently owns 23 scheduled job registrations, including access codes, reminders, payment/refund reconciliation, membership reconciliation, email outboxes, waitlists, AI maintenance and retention. Keep a single API instance and a single automation scheduler initially. API cron jobs and the automation scheduler use Shario-scoped Redis ownership leases and time-slot claims during overlapping deployments. A running job renews its lease through normal graceful drain; loss or uncertainty of ownership immediately terminates the process so its supervisor can restart it. If Redis coordination is unavailable, new scheduled work is skipped. This is best-effort coordination, not an exactly-once guarantee: process pauses and external effects still require existing idempotency/reconciliation protections. Test rollout behavior and database/provider capacity before horizontal scaling. BullMQ consumers may be scaled independently after checking database, provider and concurrency limits.

A host can supervise these as five services or five processes on the same machine. This guide does not require buying five machines. Configure automatic restart on unexpected process exit.

## Container contents and secrets

The Dockerfile installs locked dependencies, builds TypeScript, prunes development packages, and copies only compiled code, production dependencies, bundled fonts and the health-check script into the final image. It uses Debian-based Node 22 in every stage for native Sharp compatibility and runs as the unprivileged `node` user.

The build-context allowlist excludes real environment files, Git history, tests, reports, logs, snapshots and local build outputs. Font files and their license remain included. Pass secrets through the hosting environment or a runtime environment file. Do not pass credentials through build arguments, bake them into the image, or copy a Skab environment file.

Builds need no production provider credentials. Runtime startup validates configuration and connects to MongoDB. It also ensures the existing product/location and knowledge indexes; use a dedicated Shario database user with the required application/index privileges. Review migrations separately rather than running migration scripts automatically during image build.

## Runtime configuration

Use `.env.example` as a field inventory, then supply actual Shario configuration. Placeholder values are not working provider credentials.

| Area | Required configuration |
| --- | --- |
| Public origins | `NODE_ENV=production`, `PORT` (defaults to `4311`), `SERVER_URL` for the public HTTPS API, `CLIENT_URL` for the HTTPS frontend. `PUBLIC_APP_URL` and `CORS_ALLOWED_ORIGINS` cover explicit additional origins. |
| MongoDB Atlas | `MONGO_URI` with the intended Shario database, dedicated credentials, and network access for every API/worker host. A replica set is required for transactions. Choose API/workers near the database. |
| Redis | `REDIS_URL` pointing to dedicated persistent Redis with a TCP/TLS connection supported by ioredis/BullMQ. A REST-only Redis endpoint is insufficient. Enable persistence and avoid eviction of queue keys. Shario prefixes do not replace provider-level separation or backups. |
| Authentication | Independent `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `WAITLIST_TOKEN_PEPPER` and `BOOKING_INTENT_SECRET`. The current frontend calls this API directly and needs no API signing secrets. The optional backend custom-domain proxy/handoff feature requires a separate frontend proxy implementation before use; do not configure those secrets in Vercel for the current frontend. Never put signing secrets in `NEXT_PUBLIC_*`. |
| Email and access codes | `AUTH_EMAIL`, `EMAIL_USER`, `EMAIL_PASSWORD`, SMTP host/port/TLS settings, independent `EMAIL_SECRET_KEY` and `COMMUNICATION_SECRET_KEY`, and `ACCESS_CODE_ENCRYPTION_KEY` for stored door codes. The current runtime schema requires SMTP fields even when managed email uses Postmark. |
| Managed Postmark email | Production requires `POSTMARK_ACCOUNT_TOKEN`, `POSTMARK_SYSTEM_SERVER_TOKEN`, `POSTMARK_SYSTEM_FROM_EMAIL`, `POSTMARK_TENANT_SERVER_PREFIX`, `POSTMARK_OUTBOUND_WEBHOOK_URL`, `POSTMARK_OUTBOUND_WEBHOOK_USERNAME`, and `POSTMARK_OUTBOUND_WEBHOOK_PASSWORD`. Verify the Shario sending domain and webhook separately. |
| Stripe | `STRIPE_KEY`, matching `STRIPE_TENANT_BILLING_MODE`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_BILLING_WEBHOOK_SECRET`, and the active Shario plan price IDs. The current schema also requires `WEBHOOK_SECRET` for compatibility. Configure each webhook endpoint/signing secret independently. Live billing also requires configured Stripe Tax and `STRIPE_AUTOMATIC_TAX_ENABLED=true`; subscription management needs `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Run provider setup scripts from a trusted local checkout with development dependencies, after choosing the intended account; those scripts can write provider configuration. |
| Cloudflare R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`; add jurisdiction/endpoint settings when needed. Use a dedicated Shario bucket and scoped credentials. Preserve application encryption for private custom-order documents. |
| Automation | `COMMUNICATION_SCHEDULER_INTERVAL_MS`. Optional feature switches, such as `NATIVE_INVOICES_ENABLED`, must match the frontend configuration. |
| AI and social sign-in | `OPENAI_API_KEY` for AI; complete Google/Apple credential groups and `CUSTOMER_SOCIAL_STATE_SECRET` only when enabling those providers. |

Configure DNS, TLS and tenant/custom-domain routing for the intended public origins. Production cookies and links use these HTTPS domains. Keep preview databases, Redis queues, buckets, provider keys and webhook destinations separate from production. Do not attach a preview API to live worker queues.

## Health checks and shutdown

The API exposes:

- `GET /health`: process liveness only; it does not prove database or email availability.
- `GET /ready`: returns 200 only after startup and a bounded primary-MongoDB probe; otherwise 503. It does not test Redis or provider delivery.

The image's default health check calls `/ready` on `127.0.0.1:$PORT` without credentials. A host should wait for readiness before routing traffic. The application already handles `SIGTERM`/`SIGINT`; allow at least **60 seconds** before force-killing a process because the default drain and cleanup budgets total 50 seconds. For Docker, set `--stop-timeout 60`; use the host's equivalent elsewhere.

Workers expose no HTTP listener. Disable the inherited Docker health check for each worker (`--no-healthcheck`, or `healthcheck: { disable: true }` in Compose) and supervise process exits instead. Monitor queue backlog/failures and the existing operational logs; a running process alone does not establish delivery. Communication delivery, communication scheduler and import workers emit `worker_operational_sample`; see [worker monitoring](worker-monitoring.md). The notification worker uses its startup/completion/failure logs.

A local container command, after configuring a runtime environment file, is:

```sh
docker run --name shario-api --restart unless-stopped \
  --env-file /secure/path/shario.env --stop-timeout 60 \
  -p 127.0.0.1:4311:4311 shario-server:RELEASE
```

Run a worker with the same runtime configuration and its command from the table:

```sh
docker run --name shario-notifications --restart unless-stopped \
  --env-file /secure/path/shario.env --stop-timeout 60 --no-healthcheck \
  shario-server:RELEASE node dist/workers/notification.worker.js
```

These commands are examples, not commands executed by this change. Behind a reverse proxy, keep the API port private and terminate TLS at the host's ingress. No local data volume is needed for application uploads: durable state lives in Atlas, Redis and R2. Back up those services separately.

## Vercel boundary

Vercel's current [Express integration](https://vercel.com/docs/frameworks/backend/express) runs the API as a Function. [Daemons](https://vercel.com/docs/daemons) can run existing BullMQ consumers, but are a production-only public beta with ephemeral storage and no inbound HTTP. Their default termination grace period is 30 seconds and would need increasing for these workers.

An all-Vercel backend needs an HTTP/scheduler startup split and direct-to-storage uploads. The current [Function request/response limit](https://vercel.com/docs/functions/limitations) is 4.5 MB. Existing imports allow 5 MB, images 8 MB, voucher PDFs 10 MB, and custom-order documents 15 MB with 40 MB batch uploads. Large private downloads also need streaming. This container does not reduce those limits or claim the unmodified API is ready for Vercel Functions.

## Validation status

The deployment pack can be checked with `npm run build` and `npm run typecheck:production`. A real Linux image build and container startup still need Docker or a compatible builder; those checks have not been run on the current development machine because Docker is unavailable. Before production, verify API readiness, all four worker processes, one synthetic booking/import, authenticated media access and the configured provider webhooks in an isolated environment.
