# Production operations audit - 2026-10-21

Initial read-only inspection: approximately 20:13-20:21 Europe/Berlin (CEST, UTC+02:00). Sources were the authenticated Render dashboard, public health GETs, and this repository at `82fccb028b1d80d1b05b2f3beceec54f01d01a81`. The deployment safeguards below were subsequently saved and verified as part of the authorized production-readiness work. No production shell commands, manual deployments, restore operations, customer messages or notification tests were performed.

The services are running, but this evidence does **not** establish complete production readiness: queue backlog and independent alerts remain unverified. **Backup/restore capability and further Atlas access checks are excluded from the current task at the user's request.** Earlier recovery observations below are retained only as the audit record, not as remaining work or a release gate for this task.

## Releases and runtime evidence

At the beginning, API and communication services showed `82fccb0` (#172) live. An independently triggered auto-deploy of [3524ba59295c0125c5b210f6773e47cf1a1dbc32](https://github.com/MartinMateju/shario-server/commit/3524ba59295c0125c5b210f6773e47cf1a1dbc32) (#173, plan entitlements/monthly quotas/subscription transitions) occurred during inspection. By the final service checks, all four services showed that newer commit as **Live**; no pending deployment was shown on those final checks. Code observations below refer to the earlier inspected commit, not a review of #173.

| Service | Final verified deployment | Runtime evidence |
| --- | --- | --- |
| API | [Live deployment](https://dashboard.render.com/web/srv-da9a77pf2nfc73erplug/deploys/dep-dbcg23mk1f9s7393aqjg), `3524ba5` | Public `/health` returned HTTP 200 with `status: ok`; `/ready` returned HTTP 200 with `status: ready, state: ready`, approximately 20:19 CEST. |
| Communication email worker | [Live deployment](https://dashboard.render.com/worker/srv-da9agn2jnfac73d7jflg/deploys/dep-dbcg23mk1f9s7393ascg), `3524ba5` | At 20:16:49, MongoDB connection succeeded and `communication-emails` worker reported running. No new job was deliberately submitted. |
| Communication scheduler | [Live deployment](https://dashboard.render.com/worker/srv-da9ammm7bikc738pqfr0/deploys/dep-dbcg23mk1f9s7393asa0), `3524ba5` | At 20:16:41, MongoDB connected, scheduler started with a 60-second interval, and its first check finished: checked 1, queued 0, skipped 0, suppressed 0, failed 0. Previous instance also completed minute checks through 20:16. |
| Data import worker | [Live deployment](https://dashboard.render.com/worker/srv-da9apl8n74is73ffku00/deploys/dep-dbcg23mk1f9s7393as70), `3524ba5` | At 20:17:24-25, MongoDB connected and `data-imports` worker reported running. No import was submitted. |

These startup and scheduler logs demonstrate activity at the stated times. They do not establish empty queues, successful delivery of every message, or successful completion of every import.

## Deployment safeguards saved after the initial inspection

All four Render production services were changed from **On Commit** to **After CI Checks Pass**. Each save was verified after the control returned to its read-only state with the Edit button restored. No billing, access or security-setting prompt appeared, and no other service setting was edited.

| Service settings | Verified saved value | Screenshot captured, 2026-10-21 CEST |
| --- | --- | --- |
| [API](https://dashboard.render.com/web/srv-da9a77pf2nfc73erplug/settings) | After CI Checks Pass | 20:39:41 |
| [Communication email worker](https://dashboard.render.com/worker/srv-da9agn2jnfac73d7jflg/settings) | After CI Checks Pass | 20:36:53 |
| [Communication scheduler](https://dashboard.render.com/worker/srv-da9ammm7bikc738pqfr0/settings) | After CI Checks Pass | 20:37:48 |
| [Data import worker](https://dashboard.render.com/worker/srv-da9apl8n74is73ffku00/settings) | After CI Checks Pass | 20:38:41 |

Render waits for the linked revision's detected CI checks; GitHub `success`, `neutral` and `skipped` conclusions count as passing. Zero detected checks or any failed check prevents an automatic deploy. This is an automatic-deploy safeguard, not evidence that the pending release passed CI or was deployed. See [Render's CI integration behavior](https://render.com/docs/deploys#integrating-with-ci).

The frontend Vercel project also has its **Release ready** check saved as **Blocking**, verified by the coordinating operator's dashboard screenshot. The evidence is retained in this task workspace as `work/readiness-evidence/vercel-release-ready-blocking.png`. Render screenshots and exact setting URLs/timestamps are retained in `work/production-readiness-evidence/render-deploy-gate-verification.json` and its four referenced PNGs. These are local audit artifacts outside this repository, not deployed application files. Passing checks and the final live release SHA still require separate verification.

## Configuration and observed warnings

- [API settings](https://dashboard.render.com/web/srv-da9a77pf2nfc73erplug/settings) use branch `main`, build `npm ci --include=dev && npm run build`, start `npm start`, Frankfurt region and Render health path `/ready`. Maintenance mode was disabled.
- API and all three workers were inspected: service notifications inherit **Use workspace default (Only failure notifications)**; preview notifications inherit **Use account default (Disabled)**. These settings were preserved. Alert destinations, delivery receipt and an on-call escalation were not verified by these service pages; no test notification was sent.
- API and Redis log stream settings showed **Log endpoint None / Token None**, using the workspace default. No third-party log destination was configured on these inspected pages.
- In the API last-hour log sample, a 19:49:23 warning reported a Redis cache operation exceeding 200 ms and falling back to its source. Several 20:12 warnings were expired-access-token HTTP 401 rejections. Cleanup and reminder tasks also completed successfully. This was a bounded sample, not proof of absence of other errors or a quantified error-rate/latency assessment.
- [Redis information](https://dashboard.render.com/r/red-da9cu8ajnfac73dffad0/info) showed **available**, Valkey **8.1.10**, **256 MB**, **noeviction**, and persistence **Journal + Snapshot**. Its service-specific inbound rules explicitly blocked all internet traffic. The UI offered **Enable Internal Authentication**; no setting was changed.

## Gaps and limits

1. **Readiness does not cover dependencies after startup.** At the reviewed commit, [`src/app/root.routes.ts`](../src/app/root.routes.ts) serves `/health` unconditionally and `/ready` from [`runtime-readiness.ts`](../src/infrastructure/lifecycle/runtime-readiness.ts), an in-memory starting/ready/shutting-down flag. Startup waits for MongoDB and required product indexes, but the endpoint does not continuously probe MongoDB, Redis, worker presence or queue delay. A 200 response is not end-to-end health.
2. **Queue health is unverified.** Email/import workers log startup, failures and completions; the scheduler logs each completed check. Queue error logging exists in [`queue-observability.ts`](../src/infrastructure/queues/queue-observability.ts). The inspected UI did not expose waiting/active/failed counts, oldest eligible job age, stale leases, or a worker heartbeat alarm. An idle email log is not evidence of an empty queue. Repository searches found no operator-facing queue-count/age metrics or external paging integration in the inspected source/configuration.
3. **Alert effectiveness is unverified.** Render failure notifications are configured through the workspace default for the API and all three workers, but there is no inspected evidence of paging for silent worker stalls, missed scheduler ticks, rising queue age, provider failures or sustained HTTP 5xx. Actual notification delivery and escalation were not tested. A configured Render service-failure notification is not proof of an application-level queue or heartbeat alarm.
4. **Backup/restore audit excluded by request.** Before that scope decision, the repository URL search found no Atlas project/dashboard link or cluster domain, and no authenticated Atlas tab was available. Backup policy and restore history were not verified; this is not evidence that backups are disabled. Do not pursue Atlas access, a restore drill, RPO/RTO work or recovery-capability implementation as part of this task.
5. **Redis persistence observation only.** Journal + Snapshot is verified. Snapshot timestamp, restore history, R2 recovery and recovery of encryption keys were not audited and are outside the requested scope.

## Readiness remediation

The implementation added after this audit checks MongoDB with a primary `ping` before `/ready` returns 200. Disconnected/missing database handles return 503 immediately; driver and response deadlines are both one second. Concurrent requests share an in-flight probe, successful results are not cached, and lifecycle/connection state are checked again after the probe. Responses expose only the existing status and lifecycle fields, without driver errors or connection details. `/health` retains its independent liveness behavior.

Redis cache operations explicitly fall back to their source in `src/infrastructure/redis/cache.ts`. They are therefore not an API-wide readiness gate. Redis-backed email/import queues still need independent monitoring; a ready API does not assert that those queues are healthy.

Validation: the dependency/readiness unit files passed **13 tests** using the critical configuration with one worker. They cover liveness independence, startup/shutdown, disconnected and missing database handles, healthy/error responses, timeout/concurrent-probe behavior and a disconnect/shutdown during an in-flight probe. The new dependency module also passed a focused strict TypeScript check. These files are already included by the critical configuration's infrastructure glob. No production deployment was performed as part of this change.

The subsequent worker remediation emits a read-only `worker_operational_sample` at startup and every minute for email, imports and the scheduler. It includes queue counts, process activity and scheduler timing/results. Collection has a two-second deadline, retains its probe lock until the underlying operation settles, and reports unavailable metrics as null while continuing heartbeats. Shutdown stops collection before queues close. **32 focused telemetry/lifecycle tests passed.** See [worker monitoring](worker-monitoring.md) for semantics and thresholds. These logs still require an external consumer to detect a missing heartbeat; eligible-job age and alert delivery remain unverified.

## Operator checklist to close the gaps

- [x] Require detected CI checks to pass before automatic Render deploys for the API and all three workers; set the frontend Vercel Release ready check to Blocking. Saved settings are verified above; a successful pending release is not implied.
- [ ] Pin the intended release SHA across API and all three workers after concurrent releases settle. Record critical CI results for that SHA, deployment links and smoke-test evidence; do not assume an earlier SHA's tests cover a newer live release.
- [ ] Add a read-only operational view for dependency connectivity, worker heartbeat/last-success time and queue counts/oldest eligible age. Cover both `communication-emails` and `data-imports`, scheduler missed ticks, failed jobs and ambiguous delivery/refund outcomes. Keep customer content and secrets out of metrics.
- [ ] Assign an alert owner and destination. Set documented thresholds for missed scheduler ticks, queue age, failure growth, HTTP failures and dependency latency; verify one synthetic alert reaches the owner. Separate expected 401s from service-failure alerts. No alert test was performed in this audit.
- [x] Document the paired [release and code-rollback runbook](release-runbook.md), including financial/delivery record preservation, schema/index compatibility, evidence capture and uncertain-payment triage. This marks documentation complete, not a production rollout or rollback drill. The runbook records passing server regression and separately pending release gates; runtime verification remains required.

The heartbeat, scheduler timing and queue-count portion of monitoring is implemented above, without customer IDs, payloads or secrets. Eligible-job age remains explicitly uncollected: BullMQ creation time plus delay does not reliably identify eligibility after delayed promotion. The remaining external monitoring increment should alert on missing heartbeats for three minutes, stale scheduler success and sustained unavailable queue observations. Add bounded, indexed eligibility measurements before applying an email queue-age threshold, and tune import age to expected import duration. Route one synthetic alarm to the named operator and retain receipt evidence; no external alert configuration or delivery test has been performed.

Existing supporting docs: [Stripe Connect](stripe-connect.md), [voucher cancellation/refund invariants](voucher-redemption-management.md), [order-confirmation recovery](order-confirmation-recovery.md), and [commerce imports](migrations/commerce-imports.md). These describe application procedures; they do not substitute for deployment or alert-delivery evidence.
