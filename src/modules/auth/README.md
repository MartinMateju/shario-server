# Auth Module

Production-ready TypeScript auth module for a multi-tenant Express + MongoDB app.

## Includes

- `auth.constants.ts`
- `auth.types.ts`
- `auth.utils.ts`
- `auth.validators.ts`
- `auth.repository.ts`
- `controllers/`
- `services/`
- `routes/`
- `middleware/`

No root `index.ts` is included, following the explicit-import convention.

## Expected project dependencies

- `express`
- `mongoose`
- `bcryptjs`
- `jsonwebtoken`
- `zod`

## Expected user model fields

This module assumes your `User` model includes:

- `tenant`
- `firstname`
- `lastname`
- `email`
- `password` with `select: false`
- `customId`
- `tenantRole`
- `platformRole`
- `isAccessGranted`
- `refreshToken` with `select: false`
- `lastLoginAt`

For password reset support, add these optional fields to your user schema:

```ts
passwordResetOtpHash: {
  type: String,
  select: false,
},
passwordResetOtpExpiresAt: {
  type: Date,
  select: false,
},
```

## Routes

Mount for example:

```ts
import { authRouter } from "./modules/auth/routes/auth.routes.js";

app.use("/auth", authRouter);
```

Routes:

- `POST /auth` login
- `POST /auth/logout` logout
- `POST /auth/refresh` rotates the refresh credential with compare-and-swap
- `POST /auth/session-handoff` consumes a workspace handoff through the signed BFF
- `POST /auth/customer/session-handoff` consumes a customer handoff through the signed BFF
- `POST /auth/register` register
- `POST /auth/password/request` request password reset
- `POST /auth/password/verify-otp` verify OTP
- `POST /auth/password/reset` reset password
- `GET /auth/customer/social/providers` list the configured customer providers
- `GET /auth/customer/social/:provider/start` begin customer social sign-in
- `GET|POST /auth/customer/social/:provider/callback` finish customer social sign-in

## Customer social sign-in

Google and Apple social sign-in are intentionally customer-only. A social
identity can create or link a tenant customer, but it never creates a
`TenantMembership` and cannot sign in a tenant owner, staff member, or platform
account.

Register these exact provider callback paths:

- Google: `/auth/customer/social/google/callback`
- Apple: `/auth/customer/social/apple/callback`

Configure a random secret of at least 32 characters in
`CUSTOMER_SOCIAL_STATE_SECRET`, plus the complete environment group for each
enabled provider:

- Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_REDIRECT_URI`
- Apple: `APPLE_OAUTH_CLIENT_ID`, `APPLE_OAUTH_TEAM_ID`,
  `APPLE_OAUTH_KEY_ID`, `APPLE_OAUTH_PRIVATE_KEY`,
  `APPLE_OAUTH_REDIRECT_URI`

The provider-list endpoint exposes only fully configured providers so the
customer UI can hide unavailable sign-in buttons.

## Paid custom domains

Custom domains must use the signed same-origin frontend proxy documented in
[`docs/custom-domain-auth.md`](../../../docs/custom-domain-auth.md). The design
keeps refresh tokens in host-only HttpOnly cookies even when third-party
cookies are blocked. Central Google/Apple callbacks use an encrypted,
origin-bound, two-minute handoff in the URL fragment and never set a
third-party API cookie for a custom-domain session.

## Important

The password reset service creates and stores an OTP hash, but email delivery must be connected to your communication/email service.
