# Communications

Tenant-aware shared Inbox for email, WhatsApp, Instagram and in-app customer
communication.
It deliberately keeps provider transport separate from conversations so a
studio can retain one customer timeline while switching channels.

## Capabilities

- unified conversations, messages, internal notes and delivery attempts;
- compose/reply and inbound mailbox/WhatsApp/Instagram webhooks;
- deterministic or configured AI categorization, summaries, drafts,
  translation, action suggestions and voice transcription;
- confidence-based customer matching with an explicit Unmatched queue;
- location-aware routing rules, assignments and owner/admin All view;
- tenant knowledge articles used as approved drafting context;
- tenant business hours, quiet hours and rate-limited absence replies;
- conversion to the existing `StaffTask` model;
- channel/purpose consent, suppressions, retries, fallback and idempotency;
- granular workspace permissions, restricted-conversation ACLs and audit logs;
- retention redaction/soft-delete and customer-satisfaction surveys.

Voice messages and Instagram image/video/audio attachments are downloaded from
approved Meta CDN hosts, transcribed when applicable, and retained as private
R2 objects. Each file is capped at 25 MB and each inbound event at 50 MB. The
database stores only an
internal `r2://` reference. Visible message/timeline reads replace that value
with a presigned HTTPS URL that expires after 5 minutes by default; an internal
reference is never returned to the browser. R2 credentials and a private bucket
are therefore required for live social-media ingestion. If signing is
temporarily unavailable, the attachment is returned as unavailable while the
rest of the inbox remains readable. Local/dry-run mode keeps the provider media
placeholder and does not invent a transcript.

## HTTP API

Protected routes are under `/communications`:

- `GET /overview`
- `GET|POST /conversations`, `GET|PATCH /conversations/:id`
- `GET /conversations/:id/messages`
- `POST /compose`, `/conversations/:id/reply`, `/notes`, `/assign`, `/resolve`
- `POST /conversations/:id/task`, `/customer`, `/ai/analyze`, `/ai/draft`
- `POST /conversations/:id/actions/:actionId`
- `POST /messages/:id/translate`, `/messages/:id/transcribe`
- `POST /deliveries/:id/retry`, `/deliveries/:id/fallback`
- `GET|POST /knowledge`, `PATCH|DELETE /knowledge/:id`
- `GET|POST /routing-rules`, `PATCH|DELETE /routing-rules/:id`
- `GET|PATCH /settings`
- `POST /settings/instagram/connect`, `/settings/instagram/disconnect`
- `GET|PUT /consents/:customerId`
- `GET /audit`, `GET /satisfaction`, `POST /retention/run`
- `GET /customers/:customerId/timeline`

Public endpoints:

- `POST /communications/satisfaction/:token`
- `GET|POST /webhooks/communications/:channel/:tenantKey` (email/WhatsApp)
- `GET|POST /webhooks/communications/instagram` (global, account-routed)
- `GET /communications/instagram/oauth/callback`

API responses use `{ "data": ... }`. List payloads contain `items` and
`pagination`. Conversation status is `open|pending|snoozed|closed`; priority is
`low|normal|high|urgent`; delivery status is
`queued|sending|sent|delivered|read|failed|bounced|rejected|cancelled`.

## Provider setup

### Inbound email

Point the receiving provider for `COMMUNICATION_INBOUND_DOMAIN` at shario.io and
forward its normalized webhook to:

`POST /webhooks/communications/email/{tenantKey}`

Send `X-Shario-Signature` as an HMAC-SHA256 of the exact raw body, or send
`X-Shario-Timestamp` and sign `{timestamp}.{rawBody}`. Each tenant's settings
response supplies its forwarding address and webhook path. Unique Reply-To
addresses preserve conversation threading. Provider Message-ID/event identity
is deduplicated; if omitted, a stable canonical payload hash is used.
Outbound replies emit stable `Message-ID`, `In-Reply-To` and `References`
headers automatically. Remote email attachments are fetched only from
`R2_PUBLIC_URL` or exact hosts listed in `COMMUNICATION_ATTACHMENT_HOSTS`.

### WhatsApp

Create a Meta app and subscribe its messages webhook to:

`GET|POST /webhooks/communications/whatsapp/{tenantKey}`

Use `WHATSAPP_VERIFY_TOKEN` for the GET challenge and configure the Meta app
secret as `WHATSAPP_WEBHOOK_SECRET`. Connect each studio's own WABA/phone number
through `PATCH /communications/settings`; `accessToken` is encrypted at rest,
excluded from queries and never returned. Free-form replies are enforced to the
24-hour customer-service window. Proactive/out-of-window sends require an
approved `whatsappTemplate` payload.

### Instagram

Instagram is a first-class Inbox channel but is intentionally reply-only. A
studio cannot cold-compose to a username or arbitrary scoped id. Replies must
target the app-scoped identity from a signed inbound Meta event and remain
inside Meta's 24-hour customer messaging window. The provider timestamp—not
database ingestion time—drives this window, and retries cannot bypass it.

Configure the Meta callback URL as:

`GET|POST /webhooks/communications/instagram`

Use `INSTAGRAM_VERIFY_TOKEN` for the GET challenge. POSTs must carry
`X-Hub-Signature-256`, verified over the exact raw request bytes with
`INSTAGRAM_WEBHOOK_SECRET` (normally the Meta app secret). The callback is
global because a Meta app has one callback URL; shario.io maps each signed event
to exactly one tenant using the uniquely indexed Instagram professional-account
id. The tenant-key webhook deliberately rejects Instagram.

Connect a studio through `POST /communications/settings/instagram/connect` and
redirect the browser to the returned authorization URL. The callback must
exactly match `INSTAGRAM_OAUTH_REDIRECT_URI` in Meta. OAuth state is HMAC
signed, tenant/user-bound, valid for ten minutes and one-time. The callback
exchanges the short token for a long-lived token, verifies the account, and
subscribes then reads back the required messaging webhook fields before marking
it connected. Tokens are encrypted at rest, never returned, refreshed seven
days before expiry, and expose `reconnect_required` instead of silently dying.
Disconnect attempts to unsubscribe and revoke provider permissions before
atomically clearing all local secrets; a cleanup warning is returned if Meta is
temporarily unavailable.

Meta production prerequisites are a Professional Instagram account, a Meta app
with Instagram messaging enabled, Advanced Access/App Review for the requested
business messaging permissions, exact OAuth/webhook callback allow-listing,
subscribed `messages`/`messaging_postbacks` fields, and public privacy-policy
plus user-data deletion/deauthorization documentation. This module does
**not** implement Meta's separate user-data deletion or app-deauthorization
callback endpoint; add that platform-level legal endpoint before claiming a
complete production App Review setup.

Inbound DMs, story replies/mentions, postbacks, image/video/audio attachments,
echoes and available delivery/read receipts are normalized. Identity uses the
account-scoped id (username is display-only), allowing a matched customer to
retain a cross-channel timeline. Context is exposed as `message.instagram`;
window state is exposed as `conversation.metadata.instagram` and
`conversation.replyEligibility.instagram`. Outbound Instagram media and public
comment moderation are intentionally outside this transport; replies are text
only.

### AI gateway

`COMMUNICATION_AI_URL` may implement the provider-neutral operations `analyze`,
`draft`, `translate` and `transcribe`. Requests are JSON and authenticated with
`COMMUNICATION_AI_TOKEN`. If the gateway is unavailable, categorization and
drafting fall back deterministically, translation preserves the original, and
transcription returns empty rather than invented content.

## Workers and retention

The server checks queued/failed deliveries every minute using an atomic
queued/failed-to-sending claim. `COMMUNICATION_DELIVERY_BATCH_SIZE` bounds each
pass. Retries are exponential and every send rechecks channel enablement, quiet
hours, suppression, consent, WhatsApp template/window requirements and the
Instagram scoped recipient/window.

At 02:30 daily the retention job processes only closed conversations whose
resolution and last-message timestamps are older than the tenant cutoff. It
redacts content by default or soft-deletes it when configured, and writes a
tenant-scoped audit event. Tenant-owned private R2 social-media objects are deleted
before their references are redacted or soft-deleted. Open and recent records
are never purged.
