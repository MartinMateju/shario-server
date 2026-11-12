# Registered Sender Emails Module

Production-ready TypeScript module for tenant-scoped SMTP sender email management.

## Structure

```txt
registered_sender_emails/
├── registered-sender-email.constants.ts
├── registered-sender-email.model.ts
├── registered-sender-email.repository.ts
├── registered-sender-email.schema.ts
├── registered-sender-email.types.ts
├── registered-sender-email.utils.ts
├── registered-sender-email.validators.ts
├── controllers/
├── services/
└── routes/
```

## Features

- Tenant-aware sender email CRUD.
- Zod request validation.
- Encrypted SMTP password support.
- SMTP verification via Nodemailer.
- Safe response sanitization.
- Prevents deactivation when sender is used by active automations.
- Supports single default sender per tenant.

## Required shared dependencies

- `shared/http/asyncHandler.ts`
- `shared/http/httpErrors.ts`
- `shared/tenant/tenantContext.ts`
- `shared/auth/currentUser.ts`
- `shared/utils/emailPasswordCrypto.ts`
- `shared/logger/logger.ts`

## Integration

```ts
import registeredSenderEmailRoutes from "./modules/registered_sender_emails/routes/registered-sender-email.routes.js";

app.use("/api/registered-sender-emails", registeredSenderEmailRoutes);
```
