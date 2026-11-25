import { mongo } from "mongoose";

const { ObjectId } = mongo;
const referenceFields = ["createdBy", "order", "product", "booking"] as const;
type ReferenceField = (typeof referenceFields)[number];
const collections: Record<ReferenceField, string> = {
  createdBy: "users",
  order: "orders",
  product: "products",
  booking: "bookings",
};
const platformRoles = new Set(["super_admin", "support", "developer"]);
type Row = Record<string, unknown>;

export type MetadataAuditOptions = {
  maxDocuments?: number;
  batchSize?: number;
  maxDurationMs?: number;
  queryTimeoutMs?: number;
  includeRestrictedIds?: boolean;
  detailLimit?: number;
};

export type MetadataAuditDetail = {
  kind: "finding" | "review";
  code: string;
  metadataId: string | null;
  tenantId: string | null;
  referenceId: string | null;
};

export const metadataAuditLimits = (options: MetadataAuditOptions = {}) => {
  const bounded = (
    value: number | undefined,
    fallback: number,
    max: number,
  ) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 1 || result > max)
      throw new Error("Invalid metadata audit limit.");
    return result;
  };
  return {
    maxDocuments: bounded(options.maxDocuments, 100_000, 1_000_000),
    batchSize: bounded(options.batchSize, 200, 500),
    maxDurationMs: bounded(options.maxDurationMs, 120_000, 600_000),
    queryTimeoutMs: bounded(options.queryTimeoutMs, 3_000, 30_000),
    detailLimit: bounded(options.detailLimit, 1_000, 10_000),
  };
};

// Only BSON ObjectIds are valid schema references. Do not stringify arbitrary
// values: malformed legacy fields may contain private data or hostile objects.
const objectId = (value: unknown): mongo.ObjectId | null =>
  value instanceof ObjectId ? value : null;
const key = (value: unknown): string | null =>
  objectId(value)?.toHexString() ?? null;
const ids = (values: unknown[]): mongo.ObjectId[] => [
  ...new Map(
    values.flatMap((value) =>
      objectId(value) ? [[key(value)!, objectId(value)!] as const] : [],
    ),
  ).values(),
];
const index = (rows: Row[]) => new Map(rows.map((row) => [key(row._id), row]));

/** Read-only historical audit. No application models, middleware or write APIs. */
export async function auditMetadataReferences(
  client: mongo.MongoClient,
  databaseName: string,
  options: MetadataAuditOptions = {},
) {
  const limits = metadataAuditLimits(options);
  const started = Date.now();
  const deadline = started + limits.maxDurationMs;
  const summary = {
    schemaVersion: 1,
    kind: "historical-metadata-tenant-reference-audit",
    readOnly: true,
    consistency: "snapshot",
    status: "incomplete" as
      "clean" | "findings" | "review_required" | "incomplete",
    complete: false,
    incompleteReason: null as
      | null
      | "document_limit"
      | "deadline"
      | "query_unavailable"
      | "application_database_unverified",
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    limits,
    documentsScanned: 0,
    documentsWithFindings: 0,
    documentsRequiringReview: 0,
    referenceChecks: 0,
    findingCounts: {} as Record<string, number>,
    reviewCounts: {} as Record<string, number>,
    restrictedDetailsTruncated: false,
  };
  const details: MetadataAuditDetail[] = [];
  const db = client.db(databaseName);
  // A snapshot session provides a single point-in-time view across batches.
  // No transaction is started, committed or aborted and no data is written.
  const session = client.startSession({ snapshot: true });
  const budget = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("audit_deadline");
    return Math.max(1, Math.min(limits.queryTimeoutMs, remaining));
  };
  const read = async (
    collection: string,
    filter: mongo.Filter<mongo.Document>,
    projection: Row,
    limit: number,
  ) => {
    const timeout = budget();
    return db
      .collection(collection)
      .find(filter, {
        projection,
        limit,
        session,
        maxTimeMS: timeout,
        timeoutMS: timeout,
      })
      .toArray();
  };
  const lookup = async (
    collection: string,
    values: unknown[],
    projection: Row,
  ) => {
    const wanted = ids(values);
    return wanted.length
      ? read(collection, { _id: { $in: wanted } }, projection, wanted.length)
      : [];
  };
  const examine = async (rows: Row[]) => {
    const references = {} as Record<ReferenceField, Map<string | null, Row>>;
    // Sequential, small indexed reads keep production load bounded.
    for (const field of referenceFields)
      references[field] = index(
        await lookup(
          collections[field],
          rows.map((row) => row[field]),
          {
            _id: 1,
            tenant: 1,
            ...(field === "createdBy" ? { platformRole: 1 } : {}),
          },
        ),
      );
    const tenants = index(
      await lookup(
        "tenants",
        [
          ...rows.map((row) => row.tenant),
          ...referenceFields.flatMap((field) =>
            [...references[field].values()].map((row) => row.tenant),
          ),
        ],
        { _id: 1 },
      ),
    );
    const pairs = [
      ...new Map(
        rows.flatMap((row) => {
          const tenant = objectId(row.tenant);
          const user = objectId(row.createdBy);
          return tenant && user
            ? [[`${tenant}:${user}`, { tenant, user }] as const]
            : [];
        }),
      ).values(),
    ];
    const memberships = pairs.length
      ? await read(
          "tenantmemberships",
          { $or: pairs },
          { _id: 0, tenant: 1, user: 1 },
          pairs.length + 1,
        )
      : [];
    // Duplicate memberships must not let a capped lookup silently miss context.
    if (memberships.length > pairs.length)
      throw new Error("membership_lookup_limit");
    const membershipPairs = new Set(
      memberships.map((row) => `${key(row.tenant)}:${key(row.user)}`),
    );

    for (const row of rows) {
      let finding = false;
      let review = false;
      const record = (
        kind: "finding" | "review",
        code: string,
        reference?: unknown,
      ) => {
        if (kind === "finding") finding = true;
        else review = true;
        const counts =
          kind === "finding" ? summary.findingCounts : summary.reviewCounts;
        counts[code] = (counts[code] ?? 0) + 1;
        if (options.includeRestrictedIds) {
          if (details.length < limits.detailLimit)
            details.push({
              kind,
              code,
              metadataId: key(row._id),
              tenantId: key(row.tenant),
              referenceId: key(reference),
            });
          else summary.restrictedDetailsTruncated = true;
        }
      };
      const tenant = key(row.tenant);
      if (!tenant)
        record(
          "finding",
          row.tenant == null ? "tenant.missing" : "tenant.invalid_reference",
          row.tenant,
        );
      else if (!tenants.has(tenant))
        record("finding", "tenant.orphan", row.tenant);

      for (const field of referenceFields) {
        const value = row[field];
        if (value == null && field !== "createdBy") continue;
        summary.referenceChecks++;
        const reference = key(value);
        if (!reference) {
          record(
            "finding",
            `${field}.${value == null ? "missing" : "invalid_reference"}`,
            value,
          );
          continue;
        }
        const target = references[field].get(reference);
        if (!target) {
          record("finding", `${field}.orphan`, value);
          continue;
        }
        const owner = key(target.tenant);
        if (tenant && owner === tenant) continue;
        if (
          field === "createdBy" &&
          tenant &&
          (platformRoles.has(String(target.platformRole)) ||
            membershipPairs.has(`${tenant}:${reference}`))
        ) {
          // Historical actor identity may legitimately cross a tenant boundary.
          // Context warrants review, not an accusation or an authorization grant.
          record(
            "review",
            platformRoles.has(String(target.platformRole))
              ? "createdBy.platform_actor_context"
              : "createdBy.workspace_membership_context",
            value,
          );
          continue;
        }
        if (!owner) record("finding", `${field}.target_tenant_invalid`, value);
        else if (!tenants.has(owner))
          record("finding", `${field}.target_tenant_orphan`, value);
        if (tenant && owner && owner !== tenant)
          record("finding", `${field}.tenant_mismatch`, value);
      }
      summary.documentsScanned++;
      if (finding) summary.documentsWithFindings++;
      if (review) summary.documentsRequiringReview++;
    }
  };

  const cursor = db.collection("metadatas").find(
    {},
    {
      projection: {
        _id: 1,
        tenant: 1,
        createdBy: 1,
        order: 1,
        product: 1,
        booking: 1,
      },
      sort: { _id: 1 },
      hint: { _id: 1 },
      session,
      limit: limits.maxDocuments + 1,
      batchSize: limits.batchSize,
      maxTimeMS: limits.queryTimeoutMs,
      timeoutMS: limits.maxDurationMs,
    },
  );
  try {
    // A misspelled/empty database must not certify a nonexistent metadata
    // collection as clean. Require an existing application tenant first.
    if (
      !(await read("tenants", { _id: { $type: "objectId" } }, { _id: 1 }, 1))
        .length
    )
      summary.incompleteReason = "application_database_unverified";
    while (!summary.incompleteReason && (await cursor.hasNext())) {
      budget();
      if (summary.documentsScanned === limits.maxDocuments) {
        summary.incompleteReason = "document_limit";
        break;
      }
      const rows: Row[] = [];
      const count = Math.min(
        limits.batchSize,
        limits.maxDocuments - summary.documentsScanned,
      );
      while (rows.length < count && (await cursor.hasNext()))
        rows.push((await cursor.next())!);
      await examine(rows);
    }
    summary.complete = summary.incompleteReason === null;
    if (summary.complete)
      summary.status =
        summary.documentsWithFindings > 0
          ? "findings"
          : summary.documentsRequiringReview > 0
            ? "review_required"
            : "clean";
  } catch {
    summary.incompleteReason =
      Date.now() >= deadline ? "deadline" : "query_unavailable";
    // Driver messages can contain hosts, credentials and malformed record data.
    // Never expose them, and never convert a failed/partial scan into clean.
  } finally {
    await cursor.close().catch(() => {});
    await session.endSession().catch(() => {});
    summary.finishedAt = new Date().toISOString();
  }
  return { summary, ...(options.includeRestrictedIds ? { details } : {}) };
}
