# Voucher purchase and delivery (step 4)

Customers can buy a voucher from the tenant's public catalog, add an optional gift message, pay through Stripe Checkout and return to a private purchase page. Skab issues the codes, renders the purchased design and manages delivery. Booking redemption and mixed voucher/card payments remain in step 5.

## Payment and issuance

- Amount, currency, connected Stripe account, live/test mode, Session ID and order reference must match the saved purchase. Only a completed, paid Session can confirm payment. A return URL never confirms a payment.
- The first verified payment time is durable before issuance begins. Retries do not move the expiry date. A minute-based reconciliation job recovers confirmed purchases whose issuance was interrupted.
- Codes, ledger entries, purchase snapshots, processed status and customer/admin delivery intents commit in one Mongo transaction. A failed enqueue rolls back issuance; duplicate events reuse the original codes and intents.
- Archived or deleted offerings cannot replace purchased artwork or terms. Historical PDF/name fallbacks are retained on the order before asynchronous delivery. Payment-expiry events cannot expire an already confirmed purchase.

## Personalization and PDF behavior

`giftMessage` accepts up to 240 normalized characters. For an editor design, checkout validates the actual personalized layout before creating a payment Session; a concurrent design change asks the buyer to retry. The message is saved separately as `giftMessageSnapshot`, and a labeled block preserves all original studio text and automatic value/code/expiry fields. Legacy uploaded PDFs stay unchanged; their gift message appears in the email.

Email and authorized downloads render from the same immutable design, asset keys, codes and gift message. PDF files are not uploaded to the public media bucket. Fonts include intact bundled language subsets, avoiding a font subsetting defect that hid some Czech serif glyphs. Historical expired PDFs remain downloadable and show their original expiry; expired, refunded or revoked vouchers cannot be emailed again.

## Private purchase access

New orders have a random nonce, a SHA-256 bearer hash and a 365-day access expiry. The proof is bound to the tenant and order with a purpose-specific HMAC. Neither the nonce nor the hash appears in normal order queries. The raw bearer is not stored in the database or returned in the checkout response.

Stripe's return URL carries the proof in its fragment. The client removes it immediately and retains it in tenant/order-scoped session storage. Status, download and resend use POST bodies through a private fetch transport, outside Redux. Polling is bounded and abortable; stale responses cannot cross tenant/order boundaries. Requests and PDFs use private/no-store headers, and public responses omit codes, asset keys, full email addresses and internal provider errors.

These endpoints are mounted under `/public/tenants/:tenantSlug/vouchers/orders/:orderId`:

| Method | Path | Body |
| --- | --- | --- |
| POST | `/status` | `{ accessToken }` |
| POST | `/download` | `{ accessToken, index }` |
| POST | `/resend` | `{ accessToken }` |

Access requires the matching tenant, order and unexpired proof, even when the studio later unpublishes its site or loses sales access. Refunds, review holds and revocation remove downloadable documents. Checkout expiry, voucher expiry and private-link expiry are separate states. Old return URLs without proof show recovery guidance and never disclose a purchase by ID alone.

Customer emails include the private link in both HTML and plain text. Recovery links use the tenant's current Skab subdomain, avoiding previously owned custom domains. `ACCESS_TOKEN_SECRET` must meet the existing production minimum of 32 bytes. Existing links are checked against their saved hash and survive secret rotation, but reconstructing a recovery link requires the original signing secret; key versioning or grant reissue must accompany a future rotation.

## Durable delivery and resend

The existing server cron supervisor processes the Mongo outbox every minute. Customer and admin messages use the tenant managed Postmark sender and verified reply address, independently of global SMTP settings. They have separate deterministic intents, leases and retry schedules. Sender resolution and attachment validation happen before the durable provider fence. Preparation failures and temporary, definitely rejected requests retry with bounded exponential backoff; permanent rejections stop for review. Claims expire safely; a crash after the provider attempt begins is recorded as ambiguous rather than automatically sending another copy. Stable message headers and delivery metadata assist diagnosis but do not guarantee deduplication or inbox delivery. The actual Postmark message ID is retained on acceptance.

An explicit buyer resend creates a new customer intent for the same codes, only to the saved buyer email. It never resets prior outcomes or issues more value. Resends are serialized with tenant mutations, limited to one per five minutes and five per UTC day, and blocked while delivery or retry is already pending. Refund/revocation/expiry checks run again before sending. Customers may still download eligible PDFs when email delivery fails or has an unknown outcome.

Ordinary emails attach the PDFs as in-memory, base64-encoded Postmark attachments. No filesystem paths, URLs or streams are accepted by the managed attachment boundary. If the combined attachments would exceed 6 MiB, the message provides the secure download link instead; this avoids MIME expansion exceeding typical email size limits. A large historical purchase without a private link records a delivery failure for review rather than exposing files publicly.

## Release and verification

Deploy the server before the client. Reuse the existing Node 22 runtime, Mongo replica set, tenant managed sender configuration and cron supervisor; no additional worker or SMTP credentials are required. Run the existing additive voucher index plan/apply command to create the delivery collection and its nonunique operational indexes. Deterministic primary keys protect enqueue idempotency independently of those scan indexes. Do not drop existing voucher indexes.

Tests cover payment matching, first-payment preservation, unconfirmed checkout rejection, transaction rollback, duplicate events, delivery fencing/retries, concurrent resend limits, tenant isolation, secret handling, refunds, historical access, gift layout and frontend request races. The Mongo integration suite exercises real transactions in CI. Interactive browser preview is unavailable in this development environment; PDF visual inspection and automated component/API checks are recorded separately.
