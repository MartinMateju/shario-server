# Tenant access, roles, and settings

`TenantMembership` is the authoritative source for workspace access. The
legacy `User.tenantRole` field is retained only as a compatibility mirror while
older application code is migrated.

## Built-in roles

- `owner`: immutable full-access role; ownership, deletion, and subscription
  management cannot be delegated.
- `admin`: workspace administration without owner-only capabilities.
- `manager`: day-to-day studio and reporting management.
- `staff`: operational access without billing or authorization management.
- `accountant`: payments, credits, invoices, and reports.
- `viewer`: read-only workspace capabilities.
- `custom`: tenant-defined permissions stored in `TenantCustomRole`.

Custom roles cannot grant `team.manage`, `roles.manage`, or owner-only
permissions. A role author also cannot grant a permission they do not possess.

## Location access

Every membership has either all-location access or an explicit set of location
IDs. A restricted manager can only grant a subset of their own locations.
Operational list and resource routes apply this scope in addition to the
workspace permission check.

## Settings ownership

- `Tenant.settings` and `PATCH /tenants/current/settings` contain shared
  workspace configuration.
- `TenantMembership.workspaceProfile` contains a person's studio-specific
  display name, job title, and calendar colour.
- `TenantMembership.preferences` contains that person's workspace language,
  timezone display, default location/calendar/landing page, notifications,
  versioned product-tour acknowledgement, and one-time Overview milestones.
- `/account` contains the current tenant-scoped login profile and password.

## API routes

All routes below require a valid access token and resolve membership authority
from MongoDB at request time.

- `GET /tenants/current/access/me`
- `PATCH /tenants/current/access/me/preferences`
- `GET /tenants/current/access/permissions`
- `GET|POST /tenants/current/access/team`
- `GET|PATCH|DELETE /tenants/current/access/team/:membershipId`
- `GET|POST /tenants/current/access/roles`
- `PATCH|DELETE /tenants/current/access/roles/:roleId`
- `GET|PATCH /tenants/current/settings`
- `GET /account`
- `PATCH /account/profile`
- `PATCH /account/password`

Deleting a team member revokes the membership. Adding the same existing tenant
user later safely reactivates that membership. The service preserves at least
one active owner and enforces the plan's administrator and staff seat limits.

For V3 plans, creating a new custom role requires the Enterprise
`customRolesAndPermissions` entitlement. Existing custom roles remain readable,
assignable and editable after a downgrade, with the same permission and tenant
checks, so owners can maintain or reduce access without losing control of the
team. Built-in roles and historical V1/V2 custom-role behavior are unchanged.
This compatibility policy does not grant permission to create additional custom
roles on a lower V3 plan.

Location creation and reactivation serialize their quota checks through the
tenant write lock. They use the stored `tenant.limits.locations` allowance,
including provisioned overrides, rather than replacing it with a catalog default.

## Existing-data migration

Preview the idempotent migration first:

```bash
npm run migration:tenant-access
```

Apply it after reviewing the summary:

```bash
npm run migration:tenant-access -- --apply
```

The migration creates memberships for existing `owner`, `admin`, and `staff`
users and reports any tenant that is left without an active owner.
