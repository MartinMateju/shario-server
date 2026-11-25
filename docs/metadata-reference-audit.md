# Historical metadata tenant-reference audit

Production was audited read-only on 2026-11-15 at 10:15 UTC with the reviewed
source below, without deploying this branch. The snapshot was complete and clean:
zero historical metadata records, zero findings, zero references requiring
review. The database's existing application tenant was verified before scanning.
See [the aggregate execution evidence](evidence/metadata-reference-audit-2026-11-15.json)
for timestamps, source/bundle hashes and limits. No historical metadata repair
was necessary; this result is limited to the retired metadata collection.

The retired `/metadata` API accepted caller-supplied `createdBy`, `order`,
`product` and `booking` IDs without checking their tenant, then populated these
references when listing records. Its route is no longer mounted and a security
contract test prevents remounting it. Current runtime code does not create or
list these records; checkout cleanup only deletes metadata within its existing
tenant/user scope. This audit does not restore the API or modify that cleanup.

The standalone auditor reads `metadatas`, `tenants`, `users`, `orders`, `products`,
`bookings` and `tenantmemberships` through the native MongoDB driver. It imports
no application models or startup code, creates no indexes, starts no workers,
contacts no providers and uses no write commands. It has **no repair mode**.

It checks required tenant/creator references, optional order/product/booking
references, missing documents, malformed BSON references and tenant ownership.
Absent/null optional references are valid. A creator outside the record's tenant
with a recognized platform role or a recorded workspace membership is reported
as **review required**, separately from confirmed structural/tenant mismatches.
Current roles or memberships cannot establish authorization at the historical
write time. Platform actor context never excuses a foreign order, product or
booking. Historical suspended/revoked membership can explain an actor reference;
it is not treated as current permission. No actor context is silently certified
as clean.

## Run the read-only audit

Use Node 22, installed repository dependencies and an already provisioned MongoDB
credential with the database's `read` role wherever available. Supply its URI
through `METADATA_AUDIT_MONGO_URI` using the established secret environment;
do not put the URI in the command, logs or evidence. The database name is explicit
to prevent an implicit driver-default database. Run on MongoDB 5.0+ replica set
or sharded cluster with snapshot reads available. No new access or production
mutation is required by this procedure.

```sh
node --import tsx src/modules/metadata/scripts/audit-metadata-references.ts \
  --database ACTUAL_DATABASE_NAME \
  --uri-env METADATA_AUDIT_MONGO_URI \
  --output /absolute/private/evidence/metadata-reference-summary.json
```

The script does not load `.env`. The output path must not already exist; files
are created with mode `0600`. Standard output and the summary contain only fixed
issue codes, aggregate counts, limits, timestamps and completeness, without
customer content, tenant IDs, provider identifiers, endpoints or credentials.
Driver error text is suppressed. Record the audited Git SHA and intended database
in the restricted operator record separately from the shareable summary.

The audit first requires an existing BSON-ID tenant in the explicitly selected
database, so a typo selecting a nonexistent database cannot yield a clean report.
An empty/not-yet-initialized application database is marked incomplete.
The audit reads one consistent snapshot across batches. Default bounds are
100,000 metadata records, 200 records per batch, three seconds per lookup and
120 seconds for the scan. Reads use projected fields and indexed IDs; only two
driver connections are permitted. Bounds can be lowered or explicitly raised
with `--max-documents`, `--batch-size`, `--query-timeout-ms`, `--max-duration-ms`
(hard maxima: 1,000,000 / 500 / 30,000 / 600,000). A document cap, expired deadline,
unsupported snapshot or failed query yields **incomplete**, never clean. The
scan window excludes connection setup (bounded to five seconds) and local
artifact writing. An empty metadata collection can correctly produce a complete
zero-record result. That establishes no historical metadata references exist,
not the integrity of unrelated business collections.

Exit codes: `0` complete and clean; `2` complete with findings or contextual
references requiring review; `3` incomplete scan; `1` setup/output failure. Retain
the summary even when the exit code is nonzero. Only a complete clean report (or
an explicitly documented review of every remaining contextual reference) can
close this historical-data check.

If investigation needs record identities, rerun with
`--details-file /absolute/private/evidence/metadata-reference-ids.json`.
This writes a separate restricted artifact containing **only BSON IDs and issue
codes**; IDs never appear in stdout. The default detail limit is 1,000, adjustable
through `--detail-limit` to 10,000. Truncation is explicit and does not truncate
the aggregate scan; a truncated detail file cannot establish all findings were
reviewed. A later rerun uses a new snapshot and may differ from the first audit.

Do not delete, reassign or rewrite records to make the report green. Investigate
each finding with its original tenant, order/booking and authorization evidence;
agree a narrow repair plan separately. This audit cannot prove absence of prior
unauthorized reads, validate every order/booking relationship, certify broader
tenant isolation, or substitute for backup restoration.
