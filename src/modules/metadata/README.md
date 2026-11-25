# Metadata module

Historical Metadata model/helper. The legacy HTTP API is **not mounted** because
its supplied references and populates were not tenant validated. Do not remount
it. Use the [read-only historical-reference audit](../../../docs/metadata-reference-audit.md)
to inspect retained records without modifying customer or financial data.

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

## Retired routes (not mounted)

```txt
GET    /metadata
POST   /metadata
POST   /metadata/bulk
```

Authentication on the old router did not establish that the supplied reference
IDs belonged to the selected tenant. Current runtime code does not call the
legacy create/list services.
