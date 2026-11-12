# Custom pottery orders

The workspace **Sales → Custom orders** section manages pottery commissions. It is separate from checkout orders, invoices and payment/refund processing. The client calls `/custom-orders`; the API and scheduler must be deployed with the matching client release.

## Workflow

- Create an order for an accessible, active studio location with a name, detailed specification, materials, positive whole piece count, start date and deadline.
- Optionally link an existing tenant customer by exact custom ID/member number, enter a contact manually, assign an active staff member, and record a quotation amount/currency.
- Add progress comments, photos and PDFs on the detail page. Up to five JPEG/PNG/WebP images (8 MiB each) and ten PDFs (15 MiB each) are supported, with a streamed 40 MiB limit per upload. Filenames and actual file content are validated.
- Close as completed or cancelled. Closed orders and their attachments remain readable, but editing, comments and attachment changes are rejected by the API. Reopening requires a reason recorded in the timeline. There is no order deletion endpoint.

The list supports search, location, all/active/overdue/closed filters and server pagination. `active` includes overdue orders. Overdue begins at the first instant after the deadline's calendar day in the location's timezone, including DST changes. Closing removes the overdue state.

## Access and integrity

Viewing uses `orders.view`; create/update/comment/close/reopen/upload uses `orders.manage`, following existing Sales authority. Every order lookup and mutation is tenant- and permitted-location-scoped. A customer portal session cannot use these workspace endpoints.

The API derives linked customer contact information and validates assignee membership and location access. It never trusts client-supplied ownership, status, timestamps or audit history. Mutations carry the last observed `revision`; concurrent or stale writes return 409. The order change and immutable audit event commit in one MongoDB transaction. Audit history is stored separately in `customorderevents`, with the latest 50 events in the detail response and older pages at `/:id/history`.

Files are encrypted before object storage, including when the bucket has a public domain. Authorized detail responses issue five-minute, attachment-specific signed capabilities; the client refreshes them while the page is open. Removing an attachment revokes its capability by removing the database reference. Lost upload races clean up their uncommitted objects. PDFs download as attachments with restrictive response headers.

## Deadline reminders

The existing communication scheduler independently scans pending custom-order reminders every normal scheduler interval (one minute by default), at most 100 orders per tick. It creates a bell notification within the last 24 hours of the deadline day and a second when overdue. These are workspace notifications, not emails.

Recipient resolution honors current active membership, `orders.view`, location access and the global in-app notification preference. Publication and the reminder marker share a transaction, so a failed inbox write retries, and repeated/concurrent scans do not duplicate reminders. Closing or rescheduling is checked against current order state. Changing the deadline/location/timezone or explicitly reopening starts a new reminder cycle. Internal reminder writes do not change the visible revision or last-updated time.

## Verification

- Unit validation/media tests and real Mongo replica-set safety tests cover permission boundaries, required fields, timezone boundaries, stale edits, concurrent closing and uploads, audit rollback and paginated history.
- Real database reminder tests cover eligible recipients, local deadline boundaries, duplicate scans and retry after a failed publication.
- The client `custom-orders.spec.js` release journey creates, edits, links a customer, uploads and retrieves a photo/PDF, comments, closes, reopens and checks mobile rendering. Its storage transport is isolated in the E2E process; no production files, orders or messages are created.
