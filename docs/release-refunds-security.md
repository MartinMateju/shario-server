# Refund and identity release changes

This change records Stripe Dashboard refunds and requires an explicit staff
decision about benefits. It does not change the deferred whole-class
cancellation or cancellation-credit policies. See
[the refund review runbook](stripe-refund-review.md) for event subscriptions,
operator replay, resolution and real-provider release validation.

## Customer email identity

A real normalized customer-email change atomically clears verification,
increments the credential version, revokes refresh sessions and invalidates
pending verification/password-reset credentials. Name/phone-only and normalized
email no-op edits preserve authentication. Guest records without a login email
remain editable. The customer API still cannot edit team/platform identities.

Replacement verification is sent after commit through the configured tenant
transport. Delivery failure leaves the new identity unverified and reports that
retry is required; the public resend flow is the recovery path. Verification
and reset credentials bind the exact email and credential version. Old unbound
links intentionally fail closed after release and must be requested again.
Issuance for a stale identity cannot expire a newer identity's valid credential.

## Data and dependency evidence

The read-only [historical metadata audit](metadata-reference-audit.md) completed
against production on 2026-11-15. Its snapshot contained no historical metadata
records and required no repair. This does not certify unrelated collections or
replace the pending backup-and-restore exercise.

Nodemailer was upgraded to 10.5.0. ExcelJS and node-cron retain their existing
versions with their nested UUID dependency pinned to patched CommonJS-compatible
11.1.1. The production dependency audit reports zero advisories at review time.
Regression coverage exercises the affected address-parser inputs, SMTP
timeouts/retry, cron registration/execution and ExcelJS workbook round trips.

## Deployment and rollback boundary

Deploy the backend before the client. Configure and validate the refund event
subscriptions using the refund runbook; this PR does not deploy code or change
Stripe Dashboard configuration. Confirm the existing operational alert
destination receives unresolved refund-review incidents after deployment.

The schema additions are readable by older code, but older backend versions do
not honor the new refund guards or email-bound credential checks. Once refunds
have been reconciled, reverting to older code while allowing cancellation,
payment fulfillment or benefit grants can restore duplicate compensation risk.
Use a rollback target that contains these fixes. Otherwise contain those writes
and customer-email changes, verification and password-reset flows before any
rollback: older verification/reset code can accept a stale identity proof that
this version correctly rejects. Prefer a forward fix if safe containment cannot
be established. Preserve reconciliation,
observation, resolution, payment, credit and credential-version records. Do not
clear guards or replay payments to force fulfillment. The prior rollback
rehearsal is not evidence that this new financial behavior survives old code.
