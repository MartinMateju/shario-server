# Verification module

Production-ready TypeScript replacement for the legacy `UserVerification.js` flow.

## What changed

- Module name: `verification`
- Model name: `VerificationToken`
- Tenant-aware verification records
- Hashed verification tokens with bcrypt
- Zod request validation
- Service/controller/routes split
- Uses `User.isEmailVerified` instead of legacy `isVerified`
- Keeps registration confirmation email as a service method

## Files

```txt
verification/
├── verification.constants.ts
├── verification.email.ts
├── verification.model.ts
├── verification.repository.ts
├── verification.schema.ts
├── verification.types.ts
├── verification.utils.ts
├── verification.validators.ts
├── controllers/
│   └── verification.controller.ts
├── routes/
│   └── verification.routes.ts
└── services/
    └── verification.service.ts
```

## Route mounting example

```ts
import verificationRoutes from "./modules/verification/routes/verification.routes.js";

app.use("/email_verification", verificationRoutes);
```

The route expects tenant context to be available through your existing tenant middleware / `buildTenantContext(req)`.

## Legacy mapping

- `UserVerification` → `VerificationToken`
- `uniqueString` → `hashedToken`
- `userId` → `user`
- `verifyEmail(userId, uniqueString)` → `verificationService.verifyEmail({ tenantId, userId, token })`
- `sendRegisterConformationEmail` → `sendRegistrationConfirmationEmail`

## Important

Your legacy code used `isVerified`, but your current user schema uses `isEmailVerified`. This module updates `isEmailVerified`.
