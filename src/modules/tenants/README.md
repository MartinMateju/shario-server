# Tenants module

Suggested location:

```txt
src/modules/tenants/
```

This module replaces the old global Tenant model/config helpers with a typed DDD-style tenant module.

## Files

- `tenant.constants.ts` — tenant enums/constants
- `tenant.types.ts` — Mongoose and request types
- `tenant.plan.ts` — plan/module/limit config
- `tenant.schema.ts` — Mongoose schema
- `tenant.model.ts` — default model export
- `tenant.repository.ts` — database access
- `tenant.utils.ts` — tenant request helpers and plan utilities
- `tenant.validators.ts` — simple reusable validators
- `tenant.queries.ts` — reusable Mongo queries
- `middleware/resolveTenant.ts` — hostname/domain tenant resolver
- `middleware/requireTenantModule.ts` — plan/module guard
- `services/tenant.service.ts` — domain service layer

## Important import update

Old:

```ts
import Tenant from "../../../models/Tenant.js";
```

New:

```ts
import Tenant from "../modules/tenants/tenant.model.js";
```

Adjust the relative path depending on the importing file.
