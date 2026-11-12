# Shario independent fork

## Source snapshots

Created on 12 November 2026 from clean tracked Skab working trees:

- Client: `bf50fbd59d10ef354944c459f67c95e2955eed89`.
- Server: `f1c74d105c4f3c2de901473355ac5515737ee843`.

Only tracked source/assets were copied. The Shario repositories keep their own Git history/remotes. No Skab `.env`, dependencies, build output or database contents were copied. Original Skab files and commit IDs are checked against a recorded hash inventory after the implementation.

## Retained

- Tenant registration, onboarding, workspaces, permissions, staff and locations.
- Availability, resource capacity, calendars, bookings, attendance, classes/events, waitlists and customer booking authentication.
- Memberships, recurring subscriptions, credits, gift vouchers, orders, Stripe payments and billing.
- Customizable websites, tenant branding, domains, public pages and customer portals.
- Communications, automation, inbox/history, notifications, knowledge and generic AI assistance.
- Inventory, suppliers, stock, staff tasks, access codes, generic custom orders, reports and imports.
- Existing guarded capabilities such as native invoices and commerce imports, with their original rollout switches.

## Removed or generalized

- Pottery pieces, My Work, per-piece checkout/pricing, firing profiles/runs, kiln management and piece collection/lost-and-found workflows.
- Pottery-only events, guides, dashboard metrics, report panels and AI data sources.
- Pottery benefits in memberships and pottery-specific product/setup controls.
- The hard-coded Grohova/Atelier Klei pottery microsite, testimonials/media and tenant-specific migration scripts.
- Resources renamed from pottery wheel/modeling-glazing to **workstation/shared table**. General capacity remains available. These changes target fresh Shario data; this is not an in-place migration of an existing Skab tenant database.

Some legacy field names and enum values are retained only for closed compatibility/rejection paths. They do not expose pottery routes, navigation or writable pottery products. Generic member numbers remain useful customer identifiers.

## Branding

Shario's approved warm, contemporary identity uses a blue connected-S symbol and lowercase wordmark, Manrope typography, white surfaces, dark ink and bright supporting colors. The platform identity is separate from each customer's configurable website identity.

## Service boundaries

Default development ports: frontend 4310, API 4311, MongoDB 27028, Redis 6381. Database and queue namespaces are Shario-specific. Signing secrets are generated locally. Production services and credentials require separate Shario configuration.

This fork does not publish a website, modify DNS, create a live billing catalogue or migrate customer data. The copied engineering notes describe inherited subsystems; this file and the root README are the authoritative scope for Shario.
