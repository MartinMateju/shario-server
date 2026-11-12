# Notification module

Production-ready TypeScript module for:

- `NotificationLog` delivery logs
- `EmailNotification` bulk notification records
- reminder email generation for firing/item notifications
- tenant-aware queries
- Zod validation
- explicit imports, no root barrel export

## Bulk reminder delivery

`POST /notifications/send-out-emails` uses the authenticated workspace's
registered SMTP sender. Callers may provide `senderEmailId`; otherwise the
active default sender (or the first active sender) is used.

The endpoint is intentionally bounded:

- 50 recipients per request
- 10 JPEG, PNG, or WebP attachments
- 2 MB per attachment and 8 MB combined
- four concurrent SMTP deliveries
- five bulk requests per minute per client IP

Successful delivery returns HTTP 200. If only some recipients fail, the
endpoint returns HTTP 207 with `sentCount`, `failedCount`, and recipient-level
failures. A failed recipient never prevents the remaining bounded work from
finishing.

The route requires `communications.send` and enforces the caller's assigned
location scope.
