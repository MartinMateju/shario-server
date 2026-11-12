# Tenant public-site editor

The editor keeps an isolated draft and published snapshot on each tenant.
Legacy `publicSite` remains a mirror of the published snapshot so older auth
responses and deployments continue to render the last published version.

## Authenticated editor API

All routes live below `/api/tenants/current/settings/public-site`.

- `GET /` returns `draft`, `published`, the `publicSite` draft alias, and editor
  revision/timestamp metadata.
- `PATCH /` accepts `{ "patch": { ... }, "revision": 3 }`. A legacy direct
  patch body remains accepted at the HTTP boundary, but it still mutates only
  the draft.
- `GET /preview` returns the normal tenant public-config contract rendered from
  the draft. It is authenticated and carries `private, no-store`.
- `POST /publish` accepts `{ "revision": 3 }` and atomically promotes that exact
  draft. It requires `workspace.publish`.
- `POST /reset-draft` restores the published snapshot to the draft.
- `POST /media/:slot` accepts multipart field `image` plus optional `revision`.
  Slots are `logo`, `favicon`, `homeHero` (`cover` is retained as an alias),
  `loginBackground`, and `registerBackground`.

Draft/reset/media changes require `workspace.update`; reads require
`workspace.view`. Revision mismatches return
`PUBLIC_SITE_REVISION_CONFLICT` (409).

Anonymous `/api/public/tenants/:tenantSlug/config` responses only serialize
`publicSiteEditor.published`, falling back to legacy `publicSite` for an
unmigrated tenant. They remain `no-store`, so a successful atomic publish is
visible on the next request and a draft can never enter an anonymous cache.

## Controlled customization

The schema permits plain localized Czech/English copy, a fixed set of colour
tokens, curated font-preset identifiers, known header navigation controls,
contact/social/legal URLs and five semantic image slots. Page copy covers
home, booking, courses, memberships, vouchers and help, plus the login,
registration and customer-portal dashboard surfaces. Global label styling can
be inherited or overridden on the home, authentication and portal surfaces.
Button text can remain empty for automatic high-contrast foreground selection
or use an explicit six-digit hex override. The customer portal additionally
exposes controlled, inheritable colour overrides for the page background,
card surfaces, body text, headings, header background and text, primary
buttons, calendar background and text, and profile-menu background under
`customerPortal.appearance`. An empty portal appearance value
inherits the active style preset/global palette; six-digit hex values are
normalized to uppercase. Unknown keys, raw font/CSS values, HTML, scripts,
unsafe URL schemes and control characters are rejected.

Customers can override the same palette privately through
`PATCH /api/account/customer-preferences` with `{ "portalAppearance": { ... } }`.
This route requires a customer session and scopes the update to the authenticated
user and tenant. Omitted keys preserve their current values; an empty string
restores inheritance from the studio. `GET /api/account` and the patch response
return the complete normalized palette at `account.portalAppearance`. The user
document excludes this field from normal projections. Personal preferences never
change the studio draft/published palette or anonymous tenant configuration.

Portal page availability is stored separately from the anonymous website under
`customerPortal.pages.<page>.enabled`. Supported pages are `calendar`,
`memberships`, `vouchers`, `studioGuide`, `bookings`, `work`, `credits`,
`invoices`, `account`, `notifications`, and `waitlists`. The portal client hides
links to disabled pages and blocks direct visits, while payment callbacks and
existing commerce records remain available to their existing workflows.
Top navigation visibility uses `customerPortal.navigation.<item>.visible` for
`bookSession`, `memberships`, `giftVouchers`, and `studioGuide`; hiding a top
link alone does not disable its destination. Both controls accept only booleans
and default to `true` for legacy tenants and versions. They use the existing
draft, preview, publish, reset, and restore lifecycle and require no migration.
These presentation settings do not replace API authorization or feature permissions.

Images are stored under `public-sites/<tenantId>/<slot>/...` in R2. JPEG, PNG
and WebP MIME types and magic bytes are checked; dimensions are bounded to
6000px and 24 megapixels; uploads are capped at 8MB. Only the HTTPS public URL
is returned. Storage credentials and internal keys are never serialized.
Replacing, clearing or resetting draft media deletes an old tenant-owned
object only after a successful revision claim and only when neither the draft
nor published snapshot still references it.

## Existing tenants

The runtime has a safe legacy fallback, so migration is not required before
deployment. To materialize snapshots explicitly:

```bash
npm run migration:public-site-editor
npm run migration:public-site-editor -- --apply
```

The first command is a dry run. The migration is idempotent, initializes the
published snapshot from the currently live legacy value and preserves any
draft created during a rolling deployment.

## Rollback behaviour

Publishing writes the same sanitized snapshot to both
`publicSiteEditor.published` and the legacy `publicSite` mirror. A deployment
rollback to the pre-editor application therefore continues to serve the last
published version and ignores the additional editor metadata. The migration is
additive and does not delete legacy fields.

`reset-draft` discards unpublished edits only. It does not unpublish the studio
or restore an older published revision; published-version history is outside
the Step 5 editor scope.
