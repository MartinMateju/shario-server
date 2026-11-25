# Operational alerts

Operational owner and destination: the address configured in `OPS_ALERT_TO` (set it to the Shario operations inbox before enabling the monitor). The external monitor checks the client, API, Mongo, Redis, all three workers, critical scheduled jobs and financial records requiring attention. It sends failure, hourly reminder and recovery emails. It never retries a payment, refund or customer delivery.

The implementation is opt-in. These PRs and the local rehearsal do not activate a production schedule or change production deployment settings. The successful synthetic email below verifies the notification transport and destination, not a running production monitor.

## Activate after the reviewed release

1. Deploy the reviewed API and all three worker revisions. Set a dedicated random `OPS_MONITOR_TOKEN` (32–512 characters) and the same `OPS_MONITOR_NAMESPACE=shario-production` on those four services. Keep the default `OPS_MONITOR_WORKERS=communication-email,communication-scheduler,data-import`. Use a different namespace/token for any test environment. Never expose this token in the frontend, URLs or logs.
2. Store these **repository secrets** in `shario-server`: `OPS_MONITOR_TOKEN`, `OPS_MONITOR_SMTP_USER`, `OPS_MONITOR_SMTP_PASSWORD`. Use a credential approved for operational mail. For the existing Postmark transactional SMTP service, the verified server token works as both SMTP username and password; a dedicated operational sending credential avoids coupling alerts to customer-mail credentials. Do not copy secrets into this document or a PR.
3. Configure the following **repository variables**. Determine the API origin from the deployed service configuration; use its direct HTTPS origin rather than an unverified alias.

| Variable | Value |
| --- | --- |
| `OPS_MONITOR_ENABLED` | Keep `false` until the remaining steps are ready |
| `OPS_MONITOR_NAMESPACE` | `shario-production` |
| `OPS_ALERT_TO` | Shario operations inbox, for example `hello@shario.io` |
| `OPS_MONITOR_API_URL` | `https://<verified-api-host>/internal/operations/health` |
| `OPS_MONITOR_WEB_URL` | `https://shario.io/api/health` |
| `OPS_MONITOR_ALLOWED_ORIGINS` | Exact comma-separated origins of the two URLs above, without trailing slashes |
| `OPS_MONITOR_FROM_EMAIL` | Verified operational sender; the existing system sender was used for the synthetic test |
| `OPS_MONITOR_SMTP_HOST` | `smtp.postmarkapp.com` for the tested transport |
| `OPS_MONITOR_SMTP_PORT` | `587` (STARTTLS); other providers may use `465` (TLS) |
| `OPS_MONITOR_POSTMARK_KEEP_ID` | `true` when using Postmark |
| `OPS_MONITOR_REMINDER_MINUTES` | `60` |

4. With the workflow on `main`, enable `OPS_MONITOR_ENABLED=true` and manually run **External operational monitor**, selecting `initialize_state=true` for the first run. Check its endpoint results and saved state artifact. Fix every unhealthy check; a process that merely starts is insufficient. Verify subsequent scheduled runs restore state and complete. During setup, a schedule that runs before initialization intentionally sends a `monitor.state-unavailable` alert.
5. Run `node scripts/operations-monitor-notification-test.mjs` with the same notification environment if the production credential/sender differs from the proven setup below. This sends one labelled operator test, with no health poll or customer writes. Retain provider delivery and operator inbox confirmation. Never put secret values on the command line.
6. Record the deployed SHAs, configuration owner, first initialized run URL and first scheduled run URL in the release record. Until this is done, **production operational alerting remains pending activation**.

The private endpoint is disabled (404) without a correctly sized token and returns 401 for invalid authorization. Authorized responses contain fixed check names, aggregate capped counts and timestamps, with `Cache-Control: no-store`; they contain no customer/order/job IDs, addresses or raw provider errors. It returns 503 when any check is unhealthy or cannot be measured. Mongo/Redis probes have bounded response deadlines and retain an in-flight lock so an unavailable dependency does not accumulate probes.

## Signals and thresholds

| Signal | Alarm condition |
| --- | --- |
| Client availability | `/api/health` must return HTTP 200 and `{status: "ok", service: "shario-client"}` |
| Public booking pages | Three anonymous GETs check for rendered courses, memberships and vouchers on `booking.commonground.example`. An unavailable screen, a missing catalogue shell, a redirect or a timeout raises a separate alert for that page. The runner reads at most 2 MiB of HTML per page and sends no API token. |
| Studio configuration throttling | The first blocked verified configuration lookup per visitor/window sets a shared 15-minute Redis signal. This catches a visitor experiencing an outage even when the synthetic visitor can browse. The signal contains no visitor or studio identifiers. |
| API/dependencies | API must be ready; Mongo ping, Redis reads and complete fresh health schema must succeed |
| Worker heartbeat | Missing, malformed or more than 3 minutes old |
| Worker queue | Unavailable counts, paused jobs, or more than 100 waiting + prioritized jobs |
| Worker progress | Waiting, prioritized or active work continuously observed without a completion for more than 15 minutes (email) or 30 minutes (imports), even with only one waiting job; delayed-only jobs do not trigger this signal |
| Worker failure | Failed attempt in the last 15 minutes, including attempts eligible for retry; retained historical failure count alone does not alarm |
| Scheduler | Last failure newer than success, success older than max(3 minutes, 3 intervals), or an overdue active scan |
| Critical API cron | Missing registration, stopped job, failed last run, overdue run or overdue success; schedule-specific budgets are defined in `cron-health.ts` |
| Paid orders | Paid `PENDING` order unchanged for at least 15 minutes |
| Refund review | Explicit review/manual-review flags or failed/canceled extension/waitlist refund state |
| Refund progress | Retry due or processing claim expired for at least 15 minutes; legitimate provider-pending age alone does not alarm |

Payment counts are capped at 100 and count records, not distinct transactions. Some parent and intent records can refer to the same refund. Global queries have short database time limits: a slow query alarms as unavailable instead of reporting zero. Review query performance at production scale before adding an operational index.

Worker failures remain unhealthy for 15 minutes after the latest failed attempt. This covers the five-minute monitor cadence plus one-minute heartbeat publication and scheduling margin, so an attempt occurring after the latest heartbeat can still be observed by a later poll. It is a bounded recent-failure signal, not durable incident acknowledgment: sufficiently delayed or missed monitor runs can still miss it, and retained failed jobs alone do not keep an alert open indefinitely.

Worker progress uses queue counts plus completion observations, not individual eligible job age. Each completion restarts the progress budget. Confirmed empty/delayed-only samples reset the continuous-work period. Gaps between successful queue-count observations preserve continuity for up to 125 seconds: two one-minute intervals plus a five-second allowance for two bounded two-second probes and one second of scheduling delay. Longer gaps reset continuity; this is a defined observation boundary, not a guarantee for arbitrary pauses. Brief unavailable samples within that boundary do not restart the budget.

The latest reporting process supplies per-process counters, which reset on restart; multiple worker replicas require care when interpreting progress. A healthy scheduler scan does not prove every possible customer automation succeeded. API cron monitoring observes existing supervision outcomes; it does not change job timeouts, retries or business behavior.

## Incident handling

- The owner receives an initial failure, a reminder after the configured interval while it remains unresolved, and a recovery after all configured checks pass. A changed set of failures creates a new incident. Open the monitor run and the [release runbook](release-runbook.md); investigate only through authorized application/provider views.
- Delivered-alert history is preserved separately from the current failure set. If a replacement alert cannot be delivered, the all-healthy recovery still refers to the last delivered alert and is retried until accepted. Original state artifacts are read without losing their delivered-alert history.
- SMTP has a 20-second overall deadline in addition to connection/inactivity limits. Expiry destroys the underlying socket, including implicit TLS and STARTTLS connections, so a timed-out send cannot keep the monitor process alive or continue sending commands. Acceptance before an ambiguous disconnect can still require a retry with the same Message-ID; exactly-once email delivery is not guaranteed.
- For unavailable services, inspect deployment revision, readiness and dependency connectivity. For workers/jobs, inspect heartbeat age, last success and queue state before restarting or scaling. For refund/order alerts, preserve original idempotency keys and payment/delivery history. A timeout is not evidence that no money moved; never create a replacement refund or resend an ambiguous delivery automatically.
- State is restored only from this workflow's latest completed main-branch scheduled/manual run. Pull-request artifacts cannot supply production state. Missing/corrupt/expired state blocks normal checks and sends an owner alert; manually initialize only after reviewing the previous incident and recording why the state was lost. Retrying the latest run retains that run's delivery state when available. A retry of an older, superseded run stops before health checks, email or state upload; dispatch a new run instead.
- Failed email delivery leaves the notification pending for the next run. A stable Message-ID helps correlate retries; SMTP does not guarantee exactly-once delivery after an ambiguous network result. Postmark's `X-PM-KeepID` preserves the chosen ID, but is not a deduplication guarantee.
- GitHub Actions schedules are best effort and can be delayed or dropped. A five-minute cron is **not** a five-minute availability SLA. Runner/SMTP outages, disabled workflows or exhausted Actions capacity may prevent email alerts. Before relying on unattended production paging, connect an independent uptime/dead-man service to detect missing monitor runs and assign a backup operator/escalation route. This PR does not claim those independent escalation controls are configured.

References: [GitHub scheduled workflow limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [Postmark SMTP and Message-ID behavior](https://postmarkapp.com/developer/user-guide/send-email-with-smtp), [Postmark delivery confirmation](https://postmarkapp.com/developer/webhooks/delivery-webhook).

## Retained synthetic delivery evidence — 2026-11-14

Exactly one labelled setup message was sent through the same `sendNotification` implementation using the existing system sender and Postmark SMTP with required STARTTLS. No production outage, customer email, deployment or customer-data mutation was induced.

| Evidence | Result |
| --- | --- |
| Destination | the `OPS_ALERT_TO` address |
| Subject | `[Shario operations shario-alert-setup] TEST — no production incident` |
| SMTP acceptance | `2026-11-14T09:20:31.696Z` |
| Postmark message ID | `5df979ac-7aa8-4eb8-bf59-0fd4a9957fad` |
| Provider delivery event | `2026-11-14T09:20:32Z`, `Delivered`, non-sandboxed |
| Human confirmation | Owner replied **“Received in inbox”** in the setup chat on 2026-11-14 |
| Secret handling | Temporary credential file removed after read-only delivery verification; no secrets in repository/evidence |

Provider delivery proves the receiving mail server accepted the message. The separate owner reply supplies inbox-receipt evidence. The automated suite separately exercises failure, reminder, recovery, retry, unavailable state and malformed/stale/incomplete health responses with isolated HTTP/SMTP sinks.
