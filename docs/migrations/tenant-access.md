# Tenant access migration

This migration creates authoritative `TenantMembership` records for existing
workspace owners, administrators and staff. End customers are intentionally
not migrated because customer portal access is not workspace administration.

The migration is idempotent and runs in dry-run mode unless `--apply` is
explicitly provided.

## Before applying

1. Back up MongoDB.
2. Deploy the new tenant-access models and indexes.
3. Ensure the application can still read the legacy `User.tenantRole` field.
4. Stop administrative writes or run the migration during a quiet period.

## Dry run

```bash
npm run migration:tenant-access
```

Review:

- the number of users that would receive memberships;
- the role counts;
- skipped invalid records;
- the sample IDs;
- tenants missing `accessControlVersion`.

## Apply

```bash
npm run migration:tenant-access -- --apply
```

The role mapping is deterministic:

| Legacy `User.tenantRole` | Workspace role |
| --- | --- |
| `owner` | `owner` |
| `admin` | `admin` |
| `staff` | `staff` |
| `customer` | no workspace membership |

All migrated members initially receive access to all locations. Restrict
individual memberships after reviewing them in the Team settings interface.

## Verify

Run the dry run again:

```bash
npm run migration:tenant-access
```

`membershipsToCreate` should be zero. Also confirm that
`tenantsWithoutActiveOwner` is empty in the apply report.

## Rollout compatibility

Do not remove `User.tenantRole` immediately. The application mirrors a coarse
role (`owner`, `admin`, `staff`, or `customer`) while legacy routes are being
converted to permission middleware.

Authentication can also call `ensureLegacyWorkspaceMembershipForUser()` to
create an individual missing membership safely before the batch migration has
run. This helper is idempotent and handles concurrent duplicate-key races.

