# Cart module

Production-ready TypeScript cart module for the SKAB / studio backend architecture.

## Suggested location

```txt
src/modules/carts/
├── cart.constants.ts
├── cart.model.ts
├── cart.queries.ts
├── cart.repository.ts
├── cart.schema.ts
├── cart.types.ts
├── cart.utils.ts
├── cart.validators.ts
├── controllers/
├── routes/
└── services/
```

No root `index.ts` is included intentionally. Import directly from the needed file.

## Notes

- Uses tenant-scoped queries.
- Supports user carts and anonymous/session carts.
- Keeps the legacy credit-check endpoints.
- Recalculates item totals and cart totals before validation.
- Uses central `asyncHandler`, `httpErrors`, and `buildTenantContext`.
