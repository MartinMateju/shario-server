# End-customer Google and Apple sign-in

Google and Apple are global Skab integrations. Studio tenants never provide
OAuth credentials, and the social endpoints can create or resolve only
tenant-scoped customer users. They never create `TenantMembership` records and
reject any identity already belonging to an owner, staff member, platform
account, or other workspace member.

## Endpoints

- `GET /auth/customer/social/providers?tenantSlug=studio-olivka`
- `GET /auth/customer/social/google/start`
- `GET /auth/customer/social/apple/start`
- `GET|POST /auth/customer/social/:provider/callback`

The start endpoint accepts `tenantSlug`, `locale`, `next`, and `returnOrigin`
query parameters. `next` is restricted to `/book`, `/courses`, `/memberships`,
`/help`, and `/portal`. `/app`, absolute URLs, protocol-relative URLs, control
characters, and backslashes fail closed to `/portal`.

Authorization uses code flow, PKCE S256, OIDC nonce validation, an
AES-256-GCM-protected short-lived state, and a one-time database record to
prevent replay. Provider ID tokens are checked against the official JWKS,
issuer, audience, expiry, nonce, and verified-email claim. Provider access and
ID tokens are not stored and never appear in redirect URLs.

On success the API sets the normal HTTP-only Skab refresh cookie and redirects
to `/{locale}/login/complete?next=...` on the validated tenant origin. The
frontend completes session restoration through the existing `/auth/refresh`
endpoint.

## Environment

Always set a dedicated random value of at least 32 characters:

```dotenv
CUSTOMER_SOCIAL_STATE_SECRET=
```

Google:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://api.shario.io/auth/customer/social/google/callback
```

Apple:

```dotenv
APPLE_OAUTH_CLIENT_ID=
APPLE_OAUTH_TEAM_ID=
APPLE_OAUTH_KEY_ID=
APPLE_OAUTH_PRIVATE_KEY=
APPLE_OAUTH_REDIRECT_URI=https://api.shario.io/auth/customer/social/apple/callback
```

`APPLE_OAUTH_CLIENT_ID` is the Services ID. The private key must be the PKCS#8
`.p8` value and may use literal `\n` characters in a single-line environment
value. Apple web return URLs require HTTPS and cannot be tested directly on a
plain localhost callback; use an HTTPS staging domain or tunnel for Apple
integration testing.

A provider is returned as unavailable until its complete credential group and
the state secret are configured, allowing the frontend to hide its button.
