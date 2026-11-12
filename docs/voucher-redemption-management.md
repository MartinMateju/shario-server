# Voucher redemption and management (step 5)

Skab applies vouchers to customer bookings and keeps the voucher ledger and payment allocations. Stripe receives only the card remainder. Voucher spending is a payment method: the booking's full sale amount, tax and invoice lines are preserved.

## Customer checkout

Authenticated customers can apply one voucher in their cart or in the booking confirmation reached from a signed public booking intent. Value vouchers fund eligible open studio and class lines, leaving unused value on the code. Experience vouchers cover places in their selected class, consistent with the offering's existing experience settings. Legacy codes continue to use the account-credit claim flow.

The customer first receives a server-priced quote showing the voucher contribution, card remainder and remaining voucher value or quantity. Checkout sends those accepted amounts as `expectedVoucherQuote`; a price or balance change requires the customer to review and apply the voucher again. Quotes do not reserve funds. Both eligibility and available balance are checked again when payment is created.

- `POST /checkout/voucher/quote` accepts `{ cart, voucherCode, currency? }`.
- `POST /booking-intents/:token/voucher/quote` accepts `{ voucherCode }` and uses the signed intent's saved selection.
- Existing checkout routes accept `voucherCode` and the strict accepted quote `{ currency, totalAmountMinor, voucherAppliedMinor, remainingToPayMinor }`.
- Booking intents use `paymentMethod: "card"` with the code for both voucher-only and mixed payment. A voucher-only result is `status: "confirmed"`; a card remainder is `status: "requires_payment"`.
- `POST /checkout/orders/:orderId/voucher/cancel` requires the owning authenticated customer and verifies or expires the saved Stripe Session before releasing the voucher hold.

Voucher codes remain outside Redux, persisted carts and payment-provider metadata. Private requests use authenticated POST bodies and no-store responses; centralized logging redacts codes. Tenant and customer ownership checks apply to recovery links and cancellation. A return URL, a failed card attempt or elapsed local time never proves that a payment cannot settle.

## Accounting and concurrency

Each order retains immutable `voucherRedemptions` per invoice line, including the coupon, reservation identity, entitlement debited and monetary amount funded. `paymentAllocations` records voucher and Stripe tender separately. `grossAmountMinor` remains the full sale; `expectedAmountMinor` and the existing `paidAmountMinor` cash metric represent only the card portion.

Voucher counters, reservations and append-only ledger entries share transactions and the tenant voucher mutation lock with wallet claims, voiding and purchase refunds. Competing checkout attempts cannot reserve the same available value. An unreserved value voucher can be converted to wallet credits, including its remaining value after partial spending. Held vouchers remain unavailable for conversion until their payment is safely settled or cancelled.

Conversion consumes only the current remaining value, records that amount in `walletRedeemedValueMinor` and the voucher/credit ledgers, and permanently deactivates the code. The immutable original value and currency stay unchanged. Concurrent claims cannot produce duplicate credits; a wallet failure rolls back consumption and both ledgers. The offering associated with a course-branded value code is an organizational reference, not a restriction to that class.

Voucher-only checkout commits the booking and voucher debit atomically. Mixed checkout retains a reservation until a matching completed, paid Stripe Session is verified. Fulfillment commits booking records and voucher debits together. Duplicate events reuse the same operation identities; transaction failures do not spend additional value.

The existing minute scheduler reconciles voucher checkout Sessions. Unknown Session creation outcomes retry the exact saved request with the same provider key only inside the conservative 23-hour creation window. Later uncertainty remains held for review. Confirmed expired unpaid Sessions release the hold; an attached Session may be reconciled after the creation window. Capacity or voucher holds are never released merely because the browser returned to a cancellation page.

## Booking cancellation refunds

New voucher-funded bookings restore the canceled invoice lines to the original voucher and queue only their card-funded remainder for Stripe refund. The original expiry is unchanged; restoring expired value does not reactivate the voucher. Partial reversals are bounded by each reservation's unreversed amount or quantity. Replayed cancellation cannot restore a second copy of the value.

If a value voucher has already been converted to credits, a later cancellation of an earlier voucher-funded booking returns its value to that same conversion owner's wallet. The code stays consumed, including when its original expiry has passed. The conversion's immutable ledger evidence, original entitlement, reservation reversal limits and tenant transaction lock prevent duplicate or excessive refunds. Failure to verify the conversion or write the wallet refund rolls back the cancellation.

Cancellation, voucher restoration and the durable card refund intent commit together. The refund worker checks the original connected account, PaymentIntent, mode, amount and currency, reconciles prior provider refunds and uses a stable idempotency key. Provider-pending outcomes remain pending. Unknown creation outcomes beyond 22 hours, external refunds or inconsistent allocations require review instead of a replacement refund.

Verified late refund failure/cancellation events move matching durable requests to review and invalidate worker claims, even if a provider previously reported success. They never restore voucher value again. Customer and roster messages distinguish restored value, queued card refunds and review states. Historical wallet or card bookings retain their existing credit-refund policy.

## Tenant management

Workspace permission checks protect voucher details, ledger history and order delivery/refund actions. Details expose the original amount or entitlement, remaining and held portions, expiry, lifecycle status and chronological usage. Authorized PDF downloads and resends reuse the purchased snapshots and original codes; resends go only to the saved buyer address and keep the existing delivery limits.

- `GET /coupons/promo-codes/:couponId` returns voucher details and ledger history.
- `GET /coupons/orders/:orderId` returns purchase, delivery and action eligibility.
- `POST /coupons/orders/:orderId/download` accepts `{ index }` for a private PDF.
- `POST /coupons/orders/:orderId/resend` queues delivery to the saved recipient.
- `POST /coupons/orders/:orderId/refund` accepts a UUID `operationId` and a reason.

The Products & Classes voucher catalog exposes **Manage codes** per offering and an **All codes** view. Both purchased and manually issued codes use the existing issuing product relationship; the per-offering list is an exact ID filter rather than a text search. Manual creation in that view preselects the offering and retains its value and validity snapshots.

- `POST /coupons/promo-codes/filter` accepts optional `productId`, `status` and `archiveState` in addition to search and pagination. `archiveState` is `unarchived` (default), `archived`, or `all`; status is independent of archival.
- `PATCH /coupons/promo-codes/:couponId/archive` and `/restore` accept `{ operationId, reason? }`, with a UUID operation ID. Both require `vouchers.manage`.
- Archiving only controls list visibility. It does not invalidate a code, alter balances/expiry, release payment reservations or remove history. Restoring makes it visible again.
- Archive/restore operations append nonfinancial ledger entries, including no-op requests. Replaying an earlier archive cannot undo a later restore.

Code lists show original and remaining value, recipient, expiry, lifecycle status and separate archive state. Archiving an offering stops new issuance; archiving an issued code only organizes records; voiding a code invalidates it. Purchase refunds remain a separate financial action.

Voiding a code revokes it and does not return money. A purchase refund is a separate confirmed action, supported for eligible fully unused Connect purchases. Used, partially used, held or inconsistent purchases require reconciliation. A deterministic purchase refund intent holds the codes before contacting Stripe and records provider outcomes durably. A completed refund revokes the eligible codes through the same verified refund reconciliation as webhooks. The browser keeps the original operation ID and reason when retrying an uncertain request.

## Optional postal vouchers

Voucher offerings can opt into studio-managed postal delivery using
`voucherSettings.physicalDelivery: { enabled, postageFeeMinor }`. Missing settings
mean delivery is disabled, including for existing offerings. The nonnegative fee
uses the offering currency's minor units and is charged once for the complete
purchase, independent of voucher quantity; zero allows free postage.

Customers choose digital delivery by default. Postal checkout requires recipient
first and last names, street, city, postal code and an ISO country code. The API
checks the current offering under the tenant mutation lock and derives postage
itself. A client-supplied charge is never trusted. The saved postage and destination
remain attached to the purchase even if the offering is later edited or disabled.

Postage is a separate Stripe line and part of the verified payment total. It never
increases the printed voucher value, spendable voucher balance or converted wallet
credits. Existing full purchase refunds include postage; partial refunds still
follow the existing review policy.

The studio prints and posts vouchers itself. **Products & Classes → Vouchers →
Orders & dispatch** shows the destination, purchased postage, printable original
PDFs and dispatch action. Dispatch requires a paid, issued postal purchase without
a refund or voucher review hold. It records the staff member and time and is safe
to retry. Payment and digital email delivery remain separate from postal dispatch.
Changing a legacy status cannot mark an unpaid purchase as paid or undo dispatch.

Every paid postal order still queues the normal digital voucher email. The email
includes the same PDFs (or secure download links for oversized attachments) and
explains that printed and digital copies use the same code and share one balance.
Marking an order dispatched does not issue another code or send another voucher.
Guest purchase status shows postal progress without exposing the shipping address;
the full destination is restricted to authorized workspace order views.

- `POST /coupons/orders/:orderId/dispatch` accepts `{ operationId }` and requires
  `vouchers.manage`.
- Postal progress uses `awaiting_payment`, `awaiting_dispatch`, `dispatched`,
  `cancelled` or `review_required`; digital-only orders have no postal status.
- There is no shipping carrier integration, tracking-number service or automated
  printing. One destination and one flat postage charge apply to each purchase.

## MVP boundaries

Direct redemption supports authenticated open studio/class booking paths. Guest checkout, waitlist offers and additional-guest/prolongation purchases keep their existing payment paths. A voucher-funded studio booking with additional separately paid orders requires payment-source review before cancellation; the system does not guess how to compensate supplemental payments. Vouchers cannot be combined with wallet or membership credits in one checkout. A card remainder must meet the provider minimum.

Partially spent purchase refunds, external provider refunds and ambiguous payment states are visible review cases, not automatic wallet credits or replacement voucher issuance. Recovery of a hold outside the safe provider creation window requires confirming its payment state.

## Release and verification

Deploy the backend before the client. Before enabling the new routes, run `npm run indexes:vouchers:plan`, inspect the additive plan, then `npm run indexes:vouchers`. The inventory now creates `bookingpaymentrefunds` and `vouchermanagementrefunds` and their operational indexes before transactions first use those collections. It retains the existing unique voucher reservation/ledger indexes and does not drop indexes. No new service or secret is required; the existing cron supervisor runs checkout reconciliation and both refund workers.

Unit and component tests cover accepted quote changes, authorization, private code transport, payment splits, legacy wallet exclusion, source-aware cancellation, refund status, provider uncertainty and original snapshot accounting. Real Mongo tests in critical CI cover shared transactions, competing reservations and wallet claims, reversals, fulfillment rollback, concurrent refund requests, worker persistence and late failure races. A live Stripe test-mode checkout and email smoke test remains a release check; no real charge, refund or customer notification was triggered during implementation.
