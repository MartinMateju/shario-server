import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mongo } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditMetadataReferences } from "@/modules/metadata/metadata-reference-audit.js";
import {
  parseMetadataAuditArguments,
  runMetadataAuditCli,
} from "@/modules/metadata/scripts/audit-metadata-references.js";

const { ObjectId } = mongo;
const database = "metadata_reference_audit_test";
const names = [
  "metadatas",
  "tenants",
  "users",
  "orders",
  "products",
  "bookings",
  "tenantmemberships",
];
const tenant = new ObjectId();
const foreignTenant = new ObjectId();
const creator = new ObjectId();
const order = new ObjectId();
const product = new ObjectId();
const booking = new ObjectId();
let server: MongoMemoryReplSet;
let client: mongo.MongoClient;
let db: mongo.Db;
const row = (overrides: mongo.Document = {}) => ({
  _id: new ObjectId(),
  tenant,
  createdBy: creator,
  order,
  product,
  booking,
  ...overrides,
});
const snapshot = async () =>
  JSON.stringify(
    await Promise.all(
      names.map((name) =>
        db.collection(name).find({}).sort({ _id: 1 }).toArray(),
      ),
    ),
  );

describe("read-only historical metadata references (isolated real Mongo)", () => {
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({
      replSet: { count: 1, ip: "127.0.0.1" },
    });
    client = new mongo.MongoClient(server.getUri(), { monitorCommands: true });
    await client.connect();
    db = client.db(database);
  });
  beforeEach(async () => {
    await Promise.all(names.map((name) => db.collection(name).deleteMany({})));
    await db
      .collection("tenants")
      .insertMany([{ _id: tenant }, { _id: foreignTenant }]);
    await db.collection("users").insertOne({
      _id: creator,
      tenant,
      email: "private-customer@example.test",
      password: "private-password",
    });
    for (const [name, id] of [
      ["orders", order],
      ["products", product],
      ["bookings", booking],
    ] as const)
      await db.collection(name).insertOne({
        _id: id,
        tenant,
        confidentialPayload: "never include me",
      });
  });
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it("certifies valid references and absent optional fields without writes or private output", async () => {
    await db
      .collection("metadatas")
      .insertMany([row(), row({ order: null, product: null, booking: null })]);
    const before = await snapshot();
    const commands: mongo.CommandStartedEvent[] = [];
    const capture = (event: mongo.CommandStartedEvent) => commands.push(event);
    client.on("commandStarted", capture);
    const result = await auditMetadataReferences(client, database, {
      batchSize: 1,
    });
    client.off("commandStarted", capture);
    expect(result.summary).toMatchObject({
      status: "clean",
      complete: true,
      documentsScanned: 2,
      referenceChecks: 5,
    });
    expect(result).not.toHaveProperty("details");
    expect(JSON.stringify(result)).not.toMatch(
      /private-customer|private-password|never include|[a-f0-9]{24}/,
    );
    expect(commands.length).toBeGreaterThan(0);
    expect(
      commands.every((event) =>
        ["find", "getMore", "killCursors"].includes(event.commandName),
      ),
    ).toBe(true);
    expect(
      commands.some((event) => event.command.readConcern?.level === "snapshot"),
    ).toBe(true);
    expect(
      commands
        .filter((event) => event.commandName === "find")
        .every(
          (event) =>
            event.command.maxTimeMS > 0 && event.command.maxTimeMS <= 3000,
        ),
    ).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  it("detects cross-tenant business references and missing targets with restricted IDs only when requested", async () => {
    await db
      .collection("orders")
      .updateOne({ _id: order }, { $set: { tenant: foreignTenant } });
    await db.collection("bookings").deleteOne({ _id: booking });
    const record = row();
    await db.collection("metadatas").insertOne(record);
    const before = await snapshot();
    const result = await auditMetadataReferences(client, database, {
      includeRestrictedIds: true,
    });
    expect(result.summary).toMatchObject({
      status: "findings",
      complete: true,
      documentsWithFindings: 1,
      findingCounts: { "order.tenant_mismatch": 1, "booking.orphan": 1 },
    });
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "order.tenant_mismatch",
          metadataId: String(record._id),
          referenceId: String(order),
        }),
        expect.objectContaining({
          code: "booking.orphan",
          referenceId: String(booking),
        }),
      ]),
    );
    expect(await snapshot()).toBe(before);
  });

  it("reports malformed/missing tenants and creators without leaking their raw values", async () => {
    await db.collection("metadatas").insertMany([
      row({ tenant: null, createdBy: null }),
      row({
        tenant: "private-tenant-value",
        createdBy: { email: "private-user-value" },
        order: "private-order-value",
      }),
      row({ tenant: new ObjectId(), createdBy: new ObjectId() }),
    ]);
    const result = await auditMetadataReferences(client, database, {
      includeRestrictedIds: true,
    });
    expect(result.summary).toMatchObject({
      status: "findings",
      documentsScanned: 3,
      findingCounts: {
        "tenant.missing": 1,
        "createdBy.missing": 1,
        "tenant.invalid_reference": 1,
        "createdBy.invalid_reference": 1,
        "order.invalid_reference": 1,
        "tenant.orphan": 1,
        "createdBy.orphan": 1,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-tenant-value|private-user-value|private-order-value/,
    );
  });

  it("detects target records with missing or orphaned ownership", async () => {
    await db
      .collection("products")
      .updateOne({ _id: product }, { $unset: { tenant: 1 } });
    await db
      .collection("orders")
      .updateOne({ _id: order }, { $set: { tenant: new ObjectId() } });
    await db.collection("metadatas").insertOne(row());
    const { summary } = await auditMetadataReferences(client, database);
    expect(summary.findingCounts).toMatchObject({
      "product.target_tenant_invalid": 1,
      "order.target_tenant_orphan": 1,
      "order.tenant_mismatch": 1,
    });
  });

  it("distinguishes platform actors and historical memberships from confirmed mismatches", async () => {
    const platform = new ObjectId();
    const member = new ObjectId();
    const unrelated = new ObjectId();
    await db.collection("users").insertMany([
      { _id: platform, tenant: foreignTenant, platformRole: "support" },
      { _id: member, tenant: foreignTenant },
      { _id: unrelated, tenant: foreignTenant, platformRole: "none" },
    ]);
    await db
      .collection("tenantmemberships")
      .insertOne({ tenant, user: member, status: "revoked" });
    await db
      .collection("metadatas")
      .insertMany([row({ createdBy: platform }), row({ createdBy: member })]);
    const contexts = await auditMetadataReferences(client, database);
    expect(contexts.summary).toMatchObject({
      status: "review_required",
      documentsWithFindings: 0,
      documentsRequiringReview: 2,
      reviewCounts: {
        "createdBy.platform_actor_context": 1,
        "createdBy.workspace_membership_context": 1,
      },
    });
    await db.collection("metadatas").insertOne(row({ createdBy: unrelated }));
    await db
      .collection("products")
      .updateOne({ _id: product }, { $set: { tenant: foreignTenant } });
    const result = await auditMetadataReferences(client, database);
    expect(result.summary.findingCounts).toMatchObject({
      "createdBy.tenant_mismatch": 1,
      "product.tenant_mismatch": 3,
    });
  });

  it("never treats a document cap as clean; exact limits and empty scans can complete", async () => {
    expect(
      (await auditMetadataReferences(client, database)).summary,
    ).toMatchObject({ status: "clean", documentsScanned: 0 });
    await db
      .collection("metadatas")
      .insertMany([row(), row(), row({ booking: new ObjectId() })]);
    const capped = await auditMetadataReferences(client, database, {
      maxDocuments: 2,
      batchSize: 1,
    });
    expect(capped.summary).toMatchObject({
      status: "incomplete",
      complete: false,
      incompleteReason: "document_limit",
      documentsScanned: 2,
    });
    const full = await auditMetadataReferences(client, database, {
      maxDocuments: 3,
      batchSize: 2,
    });
    expect(full.summary).toMatchObject({
      status: "findings",
      complete: true,
      documentsScanned: 3,
    });
  });

  it("caps restricted detail output without truncating aggregate findings", async () => {
    await db
      .collection("metadatas")
      .insertMany([
        row({ order: new ObjectId() }),
        row({ order: new ObjectId() }),
      ]);
    const result = await auditMetadataReferences(client, database, {
      includeRestrictedIds: true,
      detailLimit: 1,
    });
    expect(result.summary).toMatchObject({
      complete: true,
      documentsScanned: 2,
      documentsWithFindings: 2,
      restrictedDetailsTruncated: true,
    });
    expect(result.details).toHaveLength(1);
  });

  it("does not certify a wrong or uninitialized database as an empty clean scan", async () => {
    const result = await auditMetadataReferences(
      client,
      "not_the_application_database",
    );
    expect(result.summary).toMatchObject({
      status: "incomplete",
      complete: false,
      incompleteReason: "application_database_unverified",
      documentsScanned: 0,
    });
  });

  it("can verify an absent metadata collection in an established application database", async () => {
    await db.collection("metadatas").drop();
    const result = await auditMetadataReferences(client, database);
    expect(result.summary).toMatchObject({
      status: "clean",
      complete: true,
      documentsScanned: 0,
    });
  });

  it("keeps one snapshot when a referenced owner changes between audit reads", async () => {
    await db.collection("metadatas").insertMany([row(), row()]);
    const originalFind = mongo.Collection.prototype.find;
    let changed = false;
    vi.spyOn(mongo.Collection.prototype, "find").mockImplementation(function (
      ...args
    ) {
      const cursor = originalFind.apply(this, args);
      if (this.collectionName === "users" && !changed) {
        changed = true;
        const toArray = cursor.toArray.bind(cursor);
        vi.spyOn(cursor, "toArray").mockImplementation(async () => {
          // The source cursor has established its snapshot. This unrelated
          // test writer changes live data before the audit resolves references.
          await db
            .collection("users")
            .updateOne({ _id: creator }, { $set: { tenant: foreignTenant } });
          return toArray();
        });
      }
      return cursor;
    });
    const result = await auditMetadataReferences(client, database, {
      batchSize: 1,
    });
    expect(result.summary).toMatchObject({
      status: "clean",
      complete: true,
      documentsScanned: 2,
    });
    expect(
      (await db.collection("users").findOne({ _id: creator }))?.tenant,
    ).toEqual(foreignTenant);
  });

  it("marks an expired overall budget incomplete before examining another batch", async () => {
    await db.collection("metadatas").insertOne(row());
    const started = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(started)
      .mockReturnValue(started + 10_000);
    const result = await auditMetadataReferences(client, database, {
      maxDurationMs: 1000,
    });
    expect(result.summary).toMatchObject({
      status: "incomplete",
      complete: false,
      incompleteReason: "deadline",
    });
  });

  it("fails closed and suppresses raw driver details when a scan is unavailable", async () => {
    vi.spyOn(mongo.FindCursor.prototype, "hasNext").mockRejectedValue(
      new Error("mongodb://private:password@production-host/customer"),
    );
    const result = await auditMetadataReferences(client, database);
    expect(result.summary).toMatchObject({
      status: "incomplete",
      complete: false,
      incompleteReason: "query_unavailable",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /production-host|password|mongodb:/,
    );
  });

  it("CLI creates separate private artifacts and refuses to overwrite evidence", async () => {
    await db
      .collection("metadatas")
      .insertOne(row({ booking: new ObjectId() }));
    const directory = await mkdtemp(join(tmpdir(), "metadata-audit-"));
    const output = join(directory, "summary.json");
    const details = join(directory, "ids.json");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const args = [
        "--database",
        database,
        "--output",
        output,
        "--details-file",
        details,
      ];
      expect(
        await runMetadataAuditCli(args, { MONGO_URI: server.getUri() }),
      ).toBe(2);
      expect((await stat(details)).mode & 0o777).toBe(0o600);
      const saved = await readFile(output, "utf8");
      expect(saved).not.toMatch(/[a-f0-9]{24}/);
      expect(JSON.parse(await readFile(details, "utf8")).details).toHaveLength(
        1,
      );
      expect(stdout.mock.calls.map(([value]) => value).join("")).not.toMatch(
        /[a-f0-9]{24}/,
      );
      expect(
        await runMetadataAuditCli(args, { MONGO_URI: server.getUri() }),
      ).toBe(1);
      expect(await readFile(output, "utf8")).toBe(saved);
      expect(stderr).toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("metadata audit argument boundary", () => {
  it.each(
    [
      [],
      ["--database", "prod", "--apply", "true"],
      ["--database", "prod", "--uri", "secret"],
      ["--database", "prod", "--max-documents", "0"],
      ["--database", "prod", "--batch-size", "501"],
      ["--database", "prod", "--max-duration-ms", "600001"],
      [
        "--database",
        "prod",
        "--output",
        "/tmp/same",
        "--details-file",
        "/tmp/same",
      ],
    ].map((args) => ({ args })),
  )("refuses unsafe or unbounded arguments $args", ({ args }) => {
    expect(() => parseMetadataAuditArguments(args)).toThrow();
  });
});
