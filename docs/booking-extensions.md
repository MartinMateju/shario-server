# Customer booking extensions

Customers can extend a paid Open Studio booking by 30, 60, 90 or 120 minutes before its current end. This is independent of the restrictions on moving or cancelling a booking after its door code is issued.

`GET /bookings/mine/:id/extension/options` supplies availability, the new end time, the added price, payment methods and a quote version. `POST /bookings/mine/:id/extension` submits one option with that version, expected current end, expected amount and an idempotency key. The API checks ownership, studio opening hours, maximum duration and capacity again. Client-supplied prices are never authoritative.

The added price uses the original purchased time rate when an unambiguous monetary snapshot is available. It excludes the original one-off private-booking surcharge. Legacy bookings without that snapshot and membership-funded bookings receive an explicitly labelled current-price quote. Extensions preserve the original booking's start, guests, activity and privacy mode.

Credits can be used while the booking is active. Card checkout is offered only with at least 36 minutes remaining, allowing for Stripe's minimum checkout expiry and payment processing. A pending checkout reserves only the added interval and can be resumed or cancelled. Successful payment updates the original booking rather than creating a second customer reservation. Unfulfillable card payments enter an idempotent refund path.

Paid extension orders carry an explicit booking association and amount snapshot. A subsequent eligible cancellation includes each extension payment once; membership/voucher restoration retains its existing rules and separately restores paid added time as studio credits. Booking extension notifications use the durable transactional email outbox.

The companion client changes calendar shading to evaluate the displayed half-hour interval separately from the minimum duration of a new reservation. No booking migration or deletion is required: existing reservations receive the corrected display too, while invalid full-duration starts remain unavailable.
