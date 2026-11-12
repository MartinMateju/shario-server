# Metadata module

Production-ready TypeScript replacement for the legacy Metadata model/helper.

## Main changes

- Adds `tenant` for multi-tenancy.
- Fixes typo `Produt` -> `Product`.
- Fixes typo `createMetadaRecords` -> `createMetadataMany`.
- Uses Zod for request validation.
- Uses repository/service/controller/routes structure.
- Does not silently swallow insert errors.

## Suggested location

```txt
src/modules/metadata/
```

## Routes

```txt
GET    /metadata
POST   /metadata
POST   /metadata/bulk
```

All routes are protected by `verifyJWT`.
