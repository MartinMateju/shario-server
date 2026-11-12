# One Open Studio offering per location

Deploy the backend before the companion client. **Run the read-only preflight
before deploying either the API or the data-import worker.** Both processes
await the unique MongoDB index before they accept work, using the existing
critical startup-index pattern. MongoDB 6.0 or later is required for the partial
index's `$or`/`$in` predicates.

```sh
npm run indexes:open-studio:plan
```

The command uses the configured `MONGO_URI`, imports no models, disables
automatic indexes, prints every duplicate tenant/location group with product
IDs, and exits nonzero if resolution is needed. Planning does not write data or
indexes. Do not include this report in public logs: names and IDs belong to the
workspace.

`taxonomyReview` also blocks rollout when historical case/whitespace-normalized
or invalid kinds resolve to Open Studio but do not match the index's exact
stored taxonomy, or tenant/location/archive fields have unsupported types.
Explicitly normalize these rows after review and rerun the plan; neither script
rewrites them. Direct maintenance writers must use the same canonical enum,
ObjectId and boolean representations as the product model. Arbitrary malformed
raw MongoDB records are not a supported write contract.

Resolve duplicates with the workspace owner before rollout. Preserve booking,
purchase, invoice and product IDs. Do not delete, merge, rename or move products
automatically. Shared, exclusive and customer-choice offerings all share one
slot. Inactive products also occupy it. Canonical `kind` takes precedence over
legacy `type`; missing/null/empty kinds use `open-studio`, `workshop`,
`public-workshop` and `private-workshop`. Missing and null locations remain
unassigned and do not occupy a studio slot. Assign historical products to their actual studio
using the existing location migration only after reviewing their references;
the index rejects assignment into an occupied location. New API products require
a location, and unassigned imported/history records are not publicly bookable.

Archiving now persists `isArchived: true` and `isActive: false`, retains history,
hides the record from the catalog, and releases the Open Studio slot. Ordinary
deactivation does not archive. Earlier deletion only set `isActive: false`, so
there is no reliable way to identify older archived records: the preflight
counts all of them and requires explicit human resolution. Existing product-name
uniqueness remains in effect, including names on historical archived products.

Once the report is clean, explicitly build and verify the index:

```sh
npm run indexes:open-studio
```

The apply command only creates/verifies `one_open_studio_per_tenant_location`;
it does not modify products or drop existing indexes. A duplicate introduced
between preflight and index build also causes the build to fail safely. Run the
plan again and resolve that conflict before retrying. The API and worker repeat
the readiness check at startup; they never silently continue without the index.

The unique partial index on `{tenant: 1, location: 1}` protects API mutations,
imports, schema-valid bulk/raw writes, location assignments, kind changes, restoration and
concurrent writes. API create/update conflicts return HTTP 409 with
`code: "OPEN_STUDIO_ALREADY_EXISTS"` and
`details: {existingProductId, locationId}`. The product ID may be null if the
winning product is deleted before the conflict response lookup. Archived
products cannot be edited/reactivated through the normal API or product import.
