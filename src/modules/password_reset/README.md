# Password reset module

Production-ready OTP-based password reset module.

## Files

- `password-reset.schema.ts` / `password-reset.model.ts` - tenant-aware reset request storage
- `password-reset.validators.ts` - Zod request schemas
- `password-reset.repository.ts` - persistence layer
- `services/password-reset.service.ts` - OTP verification and password update logic
- `services/password-reset-email.service.ts` - email adapter factory
- `controllers/password-reset.controller.ts` - Express handlers
- `routes/password-reset.routes.ts` - public password reset routes

## Notes

- Uses hashed OTPs, never stores raw reset codes.
- Deletes old pending reset requests for the same user before creating a new one.
- Uses generic request response to avoid account enumeration.
- Requires tenant context to be available before these routes.
- Requires `PASSWORD_RESET_TOKEN_SECRET` or `REFRESH_TOKEN_SECRET`.
- Assumes your `User` schema hashes passwords on save only. This service updates a pre-hashed password directly.
