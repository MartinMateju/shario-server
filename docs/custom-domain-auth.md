# First-party authentication on custom domains

Browsers treat `https://api.shario.io` as a third party when a studio uses a paid
domain such as `https://studio.example`. A `SameSite=None` cookie is therefore
not a reliable refresh-session transport: privacy controls may refuse to store
or send it.

Custom-domain authentication uses a same-origin backend-for-frontend (BFF)
instead. The browser talks only to a relative endpoint on the studio domain;
the frontend server forwards the request to this API. A host-only, HttpOnly
cookie from the forwarded response is consequently stored for the studio
domain and is first-party on every later refresh or logout.

## Required environment

- API and frontend server: `AUTH_FIRST_PARTY_PROXY_SECRET`, a shared random
  value of at least 32 bytes. Never expose it through a `NEXT_PUBLIC_*`
  variable.
- API only: `AUTH_SESSION_HANDOFF_SECRET`, a different random value of at
  least 32 bytes. It encrypts two-minute OAuth/password handoffs.

The API fails closed when proxy headers are incomplete, stale, forged, or used
with a different nonce, body, request target, cookie header, or browser origin.
Every valid nonce is atomically claimed in Redis, so an exact or re-signed
replay is rejected across API instances while its timestamp could still be
accepted. Redis is therefore a required dependency for custom-domain auth.
Internal proxy headers are deliberately absent from the CORS allow-list, so a
browser cannot impersonate the BFF.

## BFF contract

For each upstream authentication request, the frontend server must:

1. Derive the exact browser origin from its trusted request URL. Do not accept
   an arbitrary origin supplied in a query or client header.
2. Remove any client-provided `x-skab-auth-proxy-*` headers.
3. Forward the browser's complete `Cookie` header to the API.
4. Canonicalize the parsed JSON body by recursively sorting object keys while
   preserving array order, then JSON-encode it. An absent body canonicalizes to
   the empty string.
5. Generate a fresh, cryptographically random nonce containing at least 128
   bits, encode it with base64url, sign the canonical request described below,
   and add the four internal headers. Never reuse a nonce, including when
   retrying a request.
6. Forward every `Set-Cookie` response header separately and unchanged. Do not
   add a `Domain` attribute. Because the browser-facing response is from the
   custom domain, the cookie becomes host-only for that domain.
7. Return the API status and JSON without caching it.

Headers:

- `x-skab-auth-proxy-origin`: exact browser origin
- `x-skab-auth-proxy-timestamp`: current Unix time in milliseconds
- `x-skab-auth-proxy-nonce`: fresh base64url-encoded random value (at least
  128 bits; 22-128 characters)
- `x-skab-auth-proxy-signature`: lowercase hex HMAC-SHA256

The HMAC input is the following newline-delimited UTF-8 string:

```text
skab-auth-proxy-v1
<timestamp>
<nonce>
<UPPERCASE_METHOD>
<exact_upstream_path_and_query>
<browser_origin>
<sha256_hex_of_forwarded_cookie_header_or_empty_string>
<sha256_hex_of_canonical_json_body_or_empty_string>
```

Sign with `AUTH_FIRST_PARTY_PROXY_SECRET`. The API accepts a 60-second clock
window. The upstream request target must be the API target, for example
`/auth/customer/refresh`, even when the browser-facing BFF route has a
different prefix.

The cookie issued through this transport is `HttpOnly`, `Secure` in
production, `SameSite=Lax`, host-only, and `Path=/`. Frontend JavaScript never
receives the refresh token.

## Password login and refresh

Prefer proxying login itself. A successful proxied login returns
`refreshSession.mode = "first-party-cookie"` and the BFF forwards the cookie.

For a controlled migration, a direct password login from a custom domain may
return:

```json
{
  "refreshSession": {
    "mode": "first-party-handoff",
    "handoff": "v1..."
  }
}
```

The value hides the raw reusable refresh token, is origin-bound, and expires
after two minutes. The handoff itself is nevertheless a short-lived redeemable
bearer and must be treated as sensitive. Post it immediately through the
same-origin BFF to the matching endpoint:

- workspace: `POST /auth/session-handoff`
- customer: `POST /auth/customer/session-handoff`

with `{ "sessionHandoff": "..." }`. The API rotates the embedded refresh token
with compare-and-swap before issuing the first-party cookie. A replay, including
a concurrent replay, therefore fails.

Once the first-party cookie exists, custom-domain refresh and logout calls must
go through the signed BFF. Direct cross-origin calls are rejected with
`AUTH_FIRST_PARTY_PROXY_REQUIRED`; the API never falls back to a third-party
refresh cookie.

## Google and Apple completion

Provider callbacks remain centralized at `api.shario.io`. For a custom-domain
return URL, the callback does **not** set an API-host refresh cookie. Instead it
places the sealed one-time handoff in the URL fragment:

```text
https://studio.example/en/login/complete?...#sessionHandoff=v1...
```

Fragments are not sent in HTTP requests or Referer headers. The completion page
must read the fragment before initializing analytics or third-party scripts,
remove it immediately with `history.replaceState`, and POST it through its BFF
to `/auth/customer/session-handoff`. Use the returned access token/session
response and let the BFF forward the first-party cookie. Apply a restrictive
Content Security Policy to the completion page because the sealed handoff is a
bearer until exchanged.

Do not put the handoff in a query string, log it, persist it to local storage,
or send it to analytics/error-reporting tools.

## Deployment order

1. Configure both secrets on the API and the proxy secret on every frontend
   server instance.
2. Deploy the BFF routes and OAuth completion-fragment handling.
3. Deploy this API version.
4. Verify password login, refresh, logout, Google and Apple on one custom
   domain with third-party cookies disabled.
5. Roll out to all custom domains.

Platform subdomains under `*.shario.io` remain same-site and continue to work
without the BFF, although using one transport consistently is encouraged.
