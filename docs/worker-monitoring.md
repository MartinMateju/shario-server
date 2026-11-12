# Worker operational telemetry

The email worker, communication scheduler and data-import worker emit one JSON
log event, `worker_operational_sample`, at startup and every 60 seconds. Queue
collection has a two-second response deadline. Sampling is read-only and does
not change `/health`, `/ready`, queue contents, retries or delivery behavior.
Keep the normal production `LOG_LEVEL=info` to retain these heartbeat events.

Each sample identifies the service role, queue, process start time and sample
time. It contains queue counts for waiting, active, delayed, prioritized, failed,
paused and waiting-children jobs; local completion and failed-attempt counters;
and the last observed completion/failure time. The scheduler additionally records
whether a tick is in progress, its last start/success/failure, duration and the
five numeric result counters. No customer, tenant, job or provider IDs, payloads,
addresses, URLs or raw errors are included in this new event.

Counters are per process and reset on restart. A BullMQ completion may be a
skipped or suppressed application job, not a delivered email. A failed-attempt
event can be retryable. The queue's retained failed count is historical and can
fall when retention removes jobs; it is not a count of new terminal failures.
Counts are observations of separate queue states, not a transactional ledger.
Scheduler `queued` is a per-tick result, not the waiting backlog.

## Missing measurements and failure behavior

`queueObservation.status` is `ok` only when every requested count is a
nonnegative integer. Otherwise `counts` is `null`, with a fixed reason:
`probe_failed`, `timeout`, `probe_in_flight`, `unsupported` or `invalid_counts`.
`lastQueueSampleSucceededAt` remains the last successful sample time. Missing
counts must never be interpreted as an empty queue.

A timeout stops waiting for a response; it does not cancel the underlying Redis
operation. No further probe starts until that operation settles. Heartbeats
continue with `probe_in_flight`, and a late result is not emitted as a fresh
sample. Graceful shutdown stops the sampling timer and any pending emission
before the existing queue shutdown. Monitoring failures do not retry jobs or
stop the worker.

`oldestEligibleJobAgeMs` is explicitly `null` and `eligibleAgeCoverage` is
`not_collected`. BullMQ clears `delay` on delayed-job promotion, so subtracting
the original creation timestamp would count planned quiet hours or retry delays
as queue delay. A future increment needs well-defined eligibility timestamps,
coverage for legacy records, and bounded indexed reads. No database indexes,
migrations or due-age collection are introduced here.

## Operator checks and alarm follow-up

1. After deployment, filter each worker's Render logs for
   `worker_operational_sample`. Confirm a recent event for each role, repeated
   minute samples and `queueObservation.status=ok`. Retain the release SHA and
   sample timestamps. A heartbeat proves the process can emit a log; it does not
   establish successful email delivery or import completion.
2. Investigate absent samples for three minutes, stale scheduler success for
   three minutes, or repeated unavailable queue samples. Allow documented
   deployment/shutdown intervals. For a running tick, examine its start time and
   duration before deciding that the scheduler is stalled.
3. Review growing waiting/active counts alongside completion and failure events.
   Check ambiguous/terminal application outcomes through the existing authorized
   application views. Do not infer successful delivery from a zero queue count,
   automatically replay ambiguous jobs, or page on every retained failed job.
4. Configure an external log/metrics consumer and a named alert owner/destination
   before treating this as active alerting. Missing-heartbeat detection must run
   outside the monitored process. Current Render workspace notifications target
   Email with Only failure notifications; that does not establish custom queue
   or heartbeat alarms. Delivery and escalation remain untested.
5. Once an owner and destination are approved, verify a synthetic monitoring
   event reaches that destination without sending customer messages or inducing
   a production outage. Retain receipt evidence. This increment does not connect
   a provider, change notification channels, send a test or schedule monitoring.

Restore capability remains excluded from this task. This telemetry does not
measure backups or recovery readiness.
