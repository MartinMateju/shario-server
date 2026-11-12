# Managed Postmark webhook setup

Managed sender setup verifies Delivery, Bounce, and SpamComplaint callbacks at
`https://api.shario.io/webhooks/postmark/outbound` before marking the sender ready.
Postmark error `1364` means at least one verification callback failed; upgrading
the email plan does not resolve that callback failure.

## Verification correlation

Each setup attempt persists a fresh random UUID before configuring its webhook.
The Postmark request includes this UUID in the custom
`X-Shario-Postmark-Provisioning-Token` header. Synthetic verification events are
correlated with that exact attempt, rather than assuming their sample `ServerID`
identifies the tenant's actual server.

The receiver still requires valid Basic Auth, a valid status-only payload, and
the configured message stream. Normal message reconciliation runs first.
Only an unmatched event without skab message metadata can be acknowledged as a
probe, and only while its token identifies an active, bound, pending sender
whose attempt started within the last five minutes. Probes do not update
deliveries or suppressions. Unmatched real-message events continue to return
503 so Postmark can retry them after message persistence completes.

A retry replaces the previous attempt token. Success or failure clears it.
Postmark retains custom headers on subsequent callbacks, but the cleared token
cannot acknowledge an unknown event. Existing message, recipient, and server
correlation remains authoritative for real events.

## Provider verification status

Postmark's live response can report verification inside each enabled trigger
(`Triggers.Delivery.Status`, `Triggers.Bounce.Status`, and
`Triggers.SpamComplaint.Status`) without a top-level `Status`. Setup accepts
this response only when all three required triggers are enabled and verified.
The documented aggregate `Status: "verified"` response is also supported.
Missing, partial, or contradictory verification evidence must still fail setup.

This distinction matters when the callbacks all return HTTP 200 but skab reports
`POSTMARK_WEBHOOK_NOT_VERIFIED`: inspect the provider's per-trigger status before
assuming verification failed. Never log the full webhook response because it can
contain Basic Auth credentials and the provisioning token.

## Deployment and verification

1. Deploy the backend change. No environment-variable or database migration is
   required; existing webhook Basic Auth and the configured URL remain in use.
2. Open the affected studio's Communications > Email setup and select **Retry
   setup**. **Refresh status** only reads the stored state.
3. Confirm the three setup callbacks return HTTP 200 and sender provisioning
   becomes ready. Reply-To verification is a separate requirement and can still
   leave overall readiness at `reply_to_pending`.
4. With the studio owner's chosen recipient, complete Reply-To verification if
   required and send a test email. Confirm its Postmark delivery event reaches
   shario.io and the managed test status updates.

Start verification from shario.io's setup flow. Directly testing an already-ready
webhook from Postmark's dashboard does not create an active setup token, so its
synthetic events will still be rejected if they have no real message match.

## Diagnostics

Render request logs identify the callback status and time. Postmark errors in
application logs retain the provider HTTP status and, when supplied, up to six
verification results containing only trigger type, success, and response status.
Credentials, the provisioning header, payloads, recipients, and arbitrary
per-trigger provider messages are excluded from these diagnostic fields.

- 401: inspect webhook Basic Auth configuration.
- 400: inspect event schema and message stream configuration.
- 503: an event could not match a real message or active verification attempt.
- 404 or connectivity errors: inspect the callback URL and reachability.

Keep webhook verification enabled. Saving an unverified webhook does not
establish successful callback delivery.

Reference: [Postmark Webhooks API](https://postmarkapp.com/developer/api/webhooks-api).
