# Studio locations module

`Location` is the operational studio-location entity for a tenant. The backend
keeps the existing model and collection name for migration compatibility; the
product UI can label the entity “Studio location”.

## Domain rules

- Every location belongs to exactly one tenant.
- A tenant may have many locations, subject to `tenant.limits.locations`.
- Only active locations count toward the plan limit.
- Every tenant must keep at least one active location.
- Exactly one active location is primary.
- Locations are archived with `isActive: false`; API deletes never hard-delete.
- Customers remain tenant-wide. They are not permanently assigned a location.
- Operational records such as bookings, orders, staff assignments, inventory,
  kilns and firings should reference a location when that record is scoped to a
  physical studio.

The unique partial index on `{ tenant, isPrimary }` enforces the single-primary
invariant at the database level. Service transactions handle primary promotion,
archiving and activation.

## Onboarding and existing tenants

Completing onboarding idempotently creates the first active primary location
from the tenant name, business address, phone and timezone. Repeating the
completion request is safe and repairs an older completed tenant that has no
location.

For a deployment with many pre-existing tenants, run the included one-off job
with the project’s normal TypeScript runner:

```bash
tsx src/modules/location/scripts/backfill-tenant-locations.ts
```

The job is idempotent. It creates missing locations, promotes an existing active
location when no primary exists, and leaves valid tenants unchanged.

An owner or tenant administrator can also repair only the current tenant through
`POST /locations/bootstrap`.

## API

- `GET /locations`
- `POST /locations`
- `POST /locations/bootstrap`
- `GET /locations/:id`
- `PATCH /locations/:id`
- `PATCH /locations/:id/set-primary`
- `PATCH /locations/:id/activate`
- `PATCH /locations/:id/deactivate`
- `DELETE /locations/:id` (archive compatibility endpoint)

Location creation, updates and lifecycle changes require owner or administrator
access. Private access instructions and door codes are excluded by default and
can only be requested by an owner or administrator.

## Canonical location contract

There is no runtime legacy location representation. `Booking.location`,
`AccessCode.location` and all other location-scoped persistence fields contain a
`Location` ObjectId. Client request payloads and filters use `locationId`.

For an existing database, deploy in this order:

1. Back up the database.
2. Run a dry scan of historical string references:

   ```bash
   tsx src/modules/location/scripts/migrate-location-references.ts
   ```

3. Review the output, then apply it:

   ```bash
   MIGRATE_LOCATION_REFERENCES_APPLY=true \
     tsx src/modules/location/scripts/migrate-location-references.ts
   ```

4. Run the primary-location repair job:

   ```bash
   tsx src/modules/location/scripts/backfill-tenant-locations.ts
   ```

5. Deploy the canonical runtime and the frontend together.

The migration converts historical booking and access-code location strings to
ObjectId references, removes obsolete notification snapshots, and fails if any
string references remain. It is the only code allowed to read the historical
string representation.

The frontend keeps only `activeStudioId` in its studio context. Calendar,
bookings, orders and other operational studio-scoped requests send that value
as `locationId`; the backend validates that it belongs to the current tenant.

The customer identity and directory are organization-wide. Customer list,
filter, create, read, update and delete requests must neither send nor consume
`activeStudioId` or `locationId`. Location-specific customer activity remains
available through the relevant operational records, without changing which
customers belong to the organization.
