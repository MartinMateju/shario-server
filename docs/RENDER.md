# Shario on Render: unapplied setup plan

The frontend preview is live at [shario-client.vercel.app/en](https://shario-client.vercel.app/en). The backend Blueprint in [`render.yaml`](../render.yaml) is a plan only: provider accounts are not ready, no Render resources have been created, and recurring spend has not been approved. A frontend preview does not establish working registration, bookings, payments or email until the API and its providers are configured.

## Services and cost

The Blueprint defines only new `shario-*` resources in Frankfurt. Confirm these names are unused before applying: Render can update an existing resource with a matching name. Use a connected GitHub integration for `MartinMateju/shario-server`, branch `main`.

| Resource | Current plan | Monthly compute estimate |
| --- | --- | ---: |
| `shario-api` | `0.5c-512mb` | $7 |
| `shario-notifications` | `0.5c-512mb` | $7 |
| `shario-communication-emails` | `0.5c-512mb` | $7 |
| `shario-communication-scheduler` | `0.5c-512mb` | $7 |
| `shario-data-imports` | `0.5c-512mb` | $7 |
| `shario-redis` | `256mb` | $10 |
| **Baseline** | | **$45/month** |

The baseline is initial sizing, not a load-tested capacity guarantee. Large imports, images and PDF rendering can need more memory. Changing the API and import worker to `1c-2g` makes the estimate **$81/month**. Workspace fees, taxes, usage overages, Atlas, R2, Postmark/SMTP, Stripe, AI and the frontend are separate. Render currently lists Hobby workspace at $0 and Pro at $25/month; this plan does not upgrade the workspace. Prices checked 13 November 2026 against [Render pricing](https://render.com/pricing): its web/private-service/background-worker table lists `0.5c-512mb` at $7 and `1c-2g` at $25; its Key Value table lists `256mb` at $10. These rows are present in the page HTML even when a text-only page viewer omits the tables.

No deployment or purchase is requested by this document. Applying the Blueprint creates paid services even if missing configuration prevents startup; leave it unapplied until credentials and the selected cost are approved.

## Prepare the providers

1. **Atlas:** use the existing dedicated `shario` database and a database user scoped to it. Keep its URI private. Registration/bookings require replica-set transactions. Allow the selected Render region's outbound addresses in Atlas; obtain those addresses from Render before opening access. `npm run doctor` performs read-only connectivity/topology checks; `--offline` checks selected local configuration only. Neither command validates provider credentials or sends email.
2. **Redis:** the Blueprint will create `shario-redis` on the same private network with persistence enabled, `noeviction`, and an empty public IP allowlist. All five Node processes receive its internal `connectionString` automatically. Do not reuse another application's Redis. Monitor memory and queue backlog; persistence is not a backup policy.
3. **R2:** create a Shario bucket and scoped access key. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and a real HTTPS `R2_PUBLIC_URL` for public media. When applicable, add `R2_JURISDICTION`/`R2_ENDPOINT` to the shared runtime environment group, so workers receive them too. Keep the existing custom-order encryption boundary intact; storage credentials stay on the API/workers.
4. **Stripe:** create/use Shario's own account or isolated test setup. Choose `STRIPE_TENANT_BILLING_MODE` to match `STRIPE_KEY`. Configure distinct webhook destinations for `/webhooks/stripe/connect` and `/webhooks/stripe/tenant-subscriptions`, supplying their respective signing secrets. The compatibility schema also requires `WEBHOOK_SECRET`; the legacy `/webhook` flow remains disabled. Set up and verify Shario's versioned subscription catalog before enabling subscription purchases; see [catalog synchronization](tenant-subscription-sync.md) and [Connect setup](stripe-connect.md). Do not reuse Skab prices or webhook secrets. For live tenant billing, complete Stripe Tax setup and add `STRIPE_AUTOMATIC_TAX_ENABLED=true` to the shared runtime group. After provider setup, run `npm run stripe:setup-billing-portal` from a trusted local checkout with development dependencies in the intended test/live account, then store its returned `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` in that group. The Render runtime prunes the `tsx` development tool required by this setup script. This command writes Stripe configuration; it has not been run as part of this deployment plan. Without those settings, live checkout or subscription-management actions deliberately fail closed.
5. **Email:** establish the Postmark account and system server, verify `notify.shario.io` and the actual sender, and supply account/server tokens plus system sender address. The Blueprint generates fresh outbound-webhook username/password values; use those values when configuring `/webhooks/postmark/outbound`. The current runtime also requires real `AUTH_EMAIL`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_HOST`, `EMAIL_PORT` and `EMAIL_SECURE` for its SMTP path. Do not enter placeholder tokens to make startup pass. See [Postmark webhook setup](postmark-webhook-setup.md).
6. **Optional features:** add `OPENAI_API_KEY` for AI and complete Google/Apple credentials for social sign-in. Add optional provider settings to the shared runtime group so every relevant service receives them. Keep native invoicing and guarded commerce-import rollout switches unchanged until their documented migration/feature prerequisites are completed.
7. **Domains and origins:** choose the public API hostname, normally `api.shario.io`, and frontend origin, normally `https://shario.io`. Set `SERVER_URL`, `CLIENT_URL` and the full Postmark webhook URL to the actual HTTPS addresses. Configure the API's custom domain/DNS/TLS in Render, and the frontend/tenant domain routing in Vercel. The current frontend calls the API directly; it needs API base URLs, **no API signing secrets**. Custom domains require the application's separate domain verification/routing setup. Update OAuth redirects and provider webhooks to these same origins.

## Blueprint configuration

The Blueprint uses Render's native Node 22 runtime, so it does not depend on an unverified Docker image. Its build command installs development tools, compiles the server, then prunes development dependencies. Each service starts its existing compiled Node entrypoint directly. The API still owns its scheduled jobs; API and automation-scheduler entrypoints now coordinate scheduled execution through the dedicated Redis.

`shario-production-runtime` holds common nonsecret settings and fresh generated signing/encryption keys, including independent `EMAIL_SECRET_KEY` and `COMMUNICATION_SECRET_KEY`. Required provider inputs use `sync: false` on `shario-api`, so the initial Blueprint form prompts once. Worker variables reference the API's values; no provider credentials are stored in Git. Render does not support `sync: false` inside environment groups. When later changing an API credential, sync the Blueprint and redeploy affected workers so their references update; service references are not live subscriptions. These behaviors follow the [current Blueprint specification](https://render.com/docs/blueprint-spec).

Keep all five services at one instance initially. The API owns 23 cron registrations; the separate communication scheduler has its own interval. Render's rolling deployments briefly overlap old and new processes even with one configured instance. The runtime now uses shared Redis ownership leases and time-slot claims for both schedulers, retains leases through normal drain, skips execution when coordination is unavailable, and exits immediately when ownership is lost or uncertain. This provides best-effort overlap protection; process pauses and external effects still require existing idempotency/reconciliation safeguards. `numInstances: 1` alone is not a distributed lock. Verify workers and scheduler rollout behavior during release validation. [Render deployment lifecycle](https://render.com/docs/deploys)

The intended auto-deploy policy is `checksPass`: linked GitHub checks must finish successfully. This requires the GitHub account/repository integration, not the unauthenticated public-repository deployment option. The API health check is `/ready`; worker services have no HTTP probe. All processes receive a 60-second shutdown allowance for their existing 50-second drain/cleanup budget. No database migration, seed or external message command is configured as a build/deploy hook.

## Apply later, then verify

After account setup and cost approval, review the six new resource names and selected region, enter the real provider inputs, and review the Blueprint's change preview before applying. Confirm Atlas is reachable from every service. Add the API custom domain, then set the matching API URL on the Vercel frontend. Keep the frontend in preview until these checks pass:

- API `/ready` returns 200; all four workers start and their queues are reachable.
- A fresh workspace can register and refresh its session across the frontend/API domains.
- A synthetic booking/import completes; large image/document uploads and private downloads work.
- Real provider configuration is verified in the intended test environment, including webhook signatures and delivery status.
- The exact deployed commit has green server CI and full regression; scheduler coordination survives an overlapping deployment.

Blueprint syntax has been checked locally against Render's current published JSON schema. This is not a Render-account validation, Linux build, provider verification, or applied deployment. The portable [container guide](DEPLOYMENT.md) remains available as an alternative packaging path.
