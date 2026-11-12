# Setup Center publication rollout

Public tenant surfaces are deny-by-default. A tenant is public only when its
`SetupCenterState.publication.status` is explicitly set to `live`.

This deliberately does not auto-publish legacy tenants. Auto-publishing would
make draft or incomplete studios visible without owner approval.

Before deploying this enforcement to an existing production database:

1. Identify the tenants that are already intended to be publicly accessible.
2. For each approved tenant, create or update its `SetupCenterState` through
   the Setup Center publish action so the usual readiness checks and audit
   event are preserved.
3. Confirm `GET /public/tenants/{slug}/config` returns `200` for approved live
   tenants and `404` for drafts.

Tenants without an explicit live state remain available to their owners through
login, password recovery, and the authenticated workspace so they can finish
setup and publish safely.

## Diagnosing a legacy tenant such as Studio Olivka

An existing tenant created before Setup Center has no publication state. This
is intentionally interpreted as `draft`; it is not an error and must not be
converted to `live` automatically.

After signing in as an owner or authorized workspace staff member, inspect the
customer-facing shell without publishing it:

```http
GET /tenants/current/settings/public-site/preview
Authorization: Bearer <access-token>
```

The response contains the same `tenant` object as the anonymous public config
plus:

```json
{
  "preview": {
    "mode": "authenticated",
    "publicationStatus": "draft",
    "hasExplicitPublicationState": false,
    "publiclyAvailable": false
  }
}
```

This endpoint is tenant-scoped from the access token, permission checked, and
served with `Cache-Control: private, no-store`. It is not available to portal
customers and does not accept a tenant slug, so it cannot preview another
workspace.

## Explicitly publishing the tenant

1. Read the authoritative readiness state:

   ```http
   GET /tenants/current/setup-center
   Authorization: Bearer <owner-access-token>
   ```

2. Resolve every required blocker returned in `data.steps`. Do not edit MongoDB
   directly and do not create a development-only public bypass.

3. Publish with the definition version returned by Setup Center:

   ```http
   POST /tenants/current/setup-center/publish
   Authorization: Bearer <owner-access-token>
   Content-Type: application/json

   {
     "expectedDefinitionVersion": 1
   }
   ```

   The publish action is owner-only, checks subscription and launch readiness,
   creates the missing legacy state as `draft`, transitions it atomically to
   `live`, and records the actor in the Setup Center audit log.

4. Verify the anonymous route:

   ```http
   GET /public/tenants/studio-olivka/config
   ```

   It must now return `200`. Before the explicit publish succeeds, the same
   endpoint must continue returning the generic `404` used for unknown,
   inactive and draft workspaces.
