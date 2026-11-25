# Custom booking domain rollout

This change prepares `booking.commonground.example` to serve the existing
`common-ground` workspace. Opening the PR does not activate the domain. Do not
cut over DNS or remove the existing redirect until the client and server PRs
have been reviewed, merged, deployed and their prerequisites verified.

## Source of truth

The API uses `tenant.domains` for ownership, status and plan entitlement.
Public configuration exposes only `tenant.publicOrigin`, never the raw domain
records or private plan data. Exactly one active primary custom domain is used
for canonical URLs and background customer links. Invalid, ambiguous,
non-primary, pending or no-longer-entitled records fall back to the standard
tenant subdomain. A valid explicitly requested tenant origin remains valid for
in-progress checkout and OAuth flows.

The frontend's `CUSTOM_DOMAIN_TENANTS` mapping must agree with the database.
Adding a hostname to a global CORS allow-list is not a replacement for tenant
ownership. Never map `www.commonground.example` to Shario: the marketing website remains
on its existing host.

## Prerequisites

1. Confirm the exact workspace ObjectId and slug; check its plan supports a
   custom domain. Do not upgrade or bypass entitlements as part of activation.
2. Register the hostname on the Shario frontend hosting project, complete domain
   ownership verification and arrange the hosting provider's required DNS/TLS.
   Record the existing DNS and redirect configuration before changing them.
3. Configure the frontend host mapping and the signed first-party auth proxy.
   Follow [the auth contract](custom-domain-auth.md): the frontend and API need
   the same server-only `AUTH_FIRST_PARTY_PROXY_SECRET`; the API also needs its
   separate `AUTH_SESSION_HANDOFF_SECRET` and functioning Redis. Never log or
   place these secrets in public environment variables.
4. Verify the deployed client serves the booking application on the custom
   hostname and that its BFF can reach the paired API. Verify the hostname
   cannot resolve another studio and unknown hosts fail closed.

## Plan and activation

Run with the target environment's `MONGO_URI`; use the actual ObjectId in place
of `TENANT_OBJECT_ID`. The default command is read-only:

```sh
npm run domains:activate -- --tenant-id TENANT_OBJECT_ID --tenant-slug common-ground --hostname booking.commonground.example
```

Review the printed before/after domain arrays. The existing Shario hostname stays
active but becomes non-primary. The tool rejects another workspace's hostname,
an ineligible/inactive workspace, malformed hostnames and duplicate records.

After the prerequisites have been checked, activate with an unused local
snapshot filename:

```sh
npm run domains:activate -- --tenant-id TENANT_OBJECT_ID --tenant-slug common-ground --hostname booking.commonground.example --apply --confirm-domain-ready --snapshot ./domain-before.json
```

The script requires the unique `domains.hostname` index, saves the exact
before/after arrays as canonical BSON Extended JSON with restrictive file
permissions (preserving embedded ObjectIds and dates), and compares the prior
domain list and plan before writing. Concurrent changes fail the comparison.
An index race cannot assign the same hostname to two tenants. A second identical
run makes no changes. This command does not alter DNS, verify ownership, change
the subscription plan or deploy application code.

Wait at least 60 seconds and the configured `PUBLIC_TENANT_CACHE_TTL_SECONDS`,
whichever is longer, for API-instance CORS and publication caches to expire.
The public configuration endpoint itself reads uncached state.

## Acceptance evidence

- Custom-domain home, course catalogue and course details return 200 with
  useful initial HTML, tenant branding and custom-domain canonical URLs.
- Public configuration's `publicOrigin` is `https://booking.commonground.example`.
- Password login, page reload, refresh, logout, registration, email verification
  and password changes work with third-party cookies blocked. Cookies are
  host-only, HttpOnly, Secure and SameSite=Lax on the custom domain.
- Google/Apple completion, where configured, exchanges its one-time fragment
  handoff through the BFF and removes the fragment before telemetry starts.
- Course checkout returns to the originating authorized tenant host. Exercise
  payment behavior in Stripe test mode, without charging a production card.
- Booking-management, verification, waitlist and voucher email links use the
  primary domain. Preserve the active platform hostname for historical links.
- Unknown origins, an unrelated tenant, forged proxy headers and replayed
  handoffs remain rejected. Record exact deployed client/server commits.

## Rollback

Keep the pre-cutover DNS/redirect record and the activation snapshot together.
If a client regression requires rollback, first restore the database domain
array using a compare-and-set: match the snapshot's `tenantId`, `tenantSlug`
and exact `nextDomains`, then set `domains` to `previousDomains`. Stop for
manual review if the current array differs; never overwrite a later domain
change. Only these domain records should be restored, not the whole tenant.

In `mongosh` connected to the same target database, load the snapshot with
`EJSON.parse`, never `JSON.parse`, then apply this narrow comparison:

```js
const snapshot = EJSON.parse(
  require("fs").readFileSync("./domain-before.json", "utf8"),
  { relaxed: false },
);
const result = db.tenants.updateOne(
  {
    _id: ObjectId(snapshot.tenantId),
    slug: snapshot.tenantSlug,
    domains: snapshot.nextDomains,
  },
  { $set: { domains: snapshot.previousDomains, updatedAt: new Date() } },
);
if (result.matchedCount !== 1)
  throw new Error("Domain state changed; stop and review before rollback.");
```

Wait for the cache grace period, restore the prior host/redirect configuration,
then verify the original Shario hostname's login, courses and checkout. Retain
the snapshot and evidence; bookings, customers, orders and payments are not
modified by the domain activation.
