import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureOpenStudioLocationIndex, reportOpenStudioLocationDuplicates,
  reportOpenStudioLocationTaxonomyReview,
  OPEN_STUDIO_LOCATION_INDEX_NAME, OPEN_STUDIO_LEGACY_TYPES,
} from "@/modules/product/open-studio-location-index.js";
import { productSchema } from "@/modules/product/product.schema.js";

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let number = 0;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri(), { autoIndex: false }).asPromise();
}, 120_000);
afterAll(async () => { await connection?.close(); await mongo?.stop(); });

const fixture = async () => {
  const db = connection.getClient().db(`open-studio-${++number}`);
  const products = db.collection("products");
  const tenant = new mongoose.Types.ObjectId();
  const location = new mongoose.Types.ObjectId();
  await ensureOpenStudioLocationIndex(products);
  return { db, products, tenant, location };
};

describe("one Open Studio per tenant/location", () => {
  it("allows exactly one winner across concurrent raw writes, regardless of booking mode or activation", async () => {
    const { db, products, tenant, location } = await fixture();
    const second = await mongoose.createConnection(mongo.getUri(db.databaseName), { autoIndex: false }).asPromise();
    try {
      const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, i) =>
        (i % 2 ? products : second.db!.collection("products")).insertOne({
          tenant, location, name: `Offering ${i}`, kind: "open-studio", type: "workshop",
          bookingMode: ["public", "private", "customer-choice"][i % 3], isActive: i % 2 === 0,
        }),
      ));
      expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.filter((result) => result.status === "rejected");
      for (const result of rejected) expect(result.reason).toMatchObject({ code: 11000 });
      expect(await products.countDocuments({ tenant, location })).toBe(1);
    } finally { await second.close(); }
  });

  it.each(OPEN_STUDIO_LEGACY_TYPES)("reserves the slot for an inactive legacy %s with missing archive flag", async (type) => {
    const { products, tenant, location } = await fixture();
    await products.insertOne({ tenant, location, type, isActive: false });
    await expect(products.insertOne({ tenant, location, kind: "open-studio", bookingMode: "private", isActive: true }))
      .rejects.toMatchObject({ code: 11000 });
  });

  it("isolates tenants/locations and allows classes, private studio and canonical overrides", async () => {
    const { products, tenant, location } = await fixture();
    await products.insertMany([
      { tenant, location, kind: "open-studio" },
      { tenant, location: new mongoose.Types.ObjectId(), kind: "open-studio" },
      { tenant: new mongoose.Types.ObjectId(), location, kind: "open-studio" },
      { tenant, location, kind: "class", type: "workshop" },
      { tenant, location, kind: "private-studio", type: "workshop" },
      { tenant, location, type: "blocker" },
      { tenant, location, type: "course" },
    ]);
    expect(await products.countDocuments()).toBe(7);
  });

  it("protects kind/location changes, bulk writes and replacement updates atomically", async () => {
    const { products, tenant, location } = await fixture();
    await products.insertOne({ tenant, location, name: "Existing", kind: "open-studio" });
    const course = (await products.insertOne({ tenant, location, name: "Course", kind: "class" })).insertedId;
    const other = (await products.insertOne({ tenant, location: new mongoose.Types.ObjectId(), kind: "open-studio" })).insertedId;
    await expect(products.updateOne({ _id: course }, { $set: { kind: "open-studio" } })).rejects.toMatchObject({ code: 11000 });
    await expect(products.updateOne({ _id: other }, { $set: { location } })).rejects.toMatchObject({ code: 11000 });
    await expect(products.bulkWrite([{ insertOne: { document: { tenant, location, type: "private-workshop" } } }])).rejects.toMatchObject({ code: 11000 });
    await expect(products.replaceOne({ _id: course }, { tenant, location, kind: "open-studio" })).rejects.toMatchObject({ code: 11000 });
    expect((await products.findOne({ _id: course }))?.kind).toBe("class");
  });

  it("releases only explicitly archived records, retains history, and blocks conflicting restoration", async () => {
    const { db, products, tenant, location } = await fixture();
    const old = (await products.insertOne({ tenant, location, name: "Original", kind: "open-studio", isActive: false })).insertedId;
    await db.collection("bookings").insertOne({ tenant, bookingProduct: old, location });
    await expect(products.insertOne({ tenant, location, name: "Replacement", kind: "open-studio" })).rejects.toMatchObject({ code: 11000 });
    await products.updateOne({ _id: old }, { $set: { isArchived: true, isActive: false } });
    await products.insertOne({ tenant, location, name: "Replacement", kind: "open-studio" });
    expect(await products.findOne({ _id: old })).toMatchObject({ name: "Original", isArchived: true });
    expect(await db.collection("bookings").findOne({ bookingProduct: old })).toMatchObject({ location });
    await expect(products.updateOne({ _id: old }, { $set: { isArchived: false } })).rejects.toMatchObject({ code: 11000 });
  });

  it("keeps unassigned history reviewable and guards assignment to a real location", async () => {
    const { products, tenant, location } = await fixture();
    const unassigned = (await products.insertOne({ tenant, type: "workshop" })).insertedId;
    await products.insertOne({ tenant, location: null, kind: "open-studio" });
    await products.insertOne({ tenant, location, kind: "open-studio" });
    await expect(products.updateOne({ _id: unassigned }, { $set: { location } })).rejects.toMatchObject({ code: 11000 });
    expect(await reportOpenStudioLocationDuplicates(products)).toEqual([]);
  });

  it("reports pre-existing duplicates and refuses index creation without changing records", async () => {
    const db = connection.getClient().db(`open-studio-${++number}`);
    const products = db.collection("products");
    const tenant = new mongoose.Types.ObjectId();
    const location = new mongoose.Types.ObjectId();
    await products.insertMany([
      { tenant, location, kind: "open-studio", name: "Public", isActive: true },
      { tenant, location, type: "private-workshop", name: "Inactive", isActive: false },
      { tenant, location, kind: "open-studio", name: "Archived", isArchived: true },
    ]);
    const before = await products.find({}).toArray();
    const report = await reportOpenStudioLocationDuplicates(products);
    expect(report).toMatchObject([{ tenantId: String(tenant), locationId: String(location), products: [{ name: "Public" }, { name: "Inactive" }] }]);
    await expect(ensureOpenStudioLocationIndex(products)).rejects.toMatchObject({ code: "OPEN_STUDIO_DUPLICATES_REQUIRE_REVIEW", duplicates: report });
    expect(await products.find({}).toArray()).toEqual(before);
    expect((await products.listIndexes().toArray()).some(({ name }) => name === OPEN_STUDIO_LOCATION_INDEX_NAME)).toBe(false);
  });

  it("has the same durable constraint for Mongoose model and concurrent startup initialization", async () => {
    const { db, products, tenant, location } = await fixture();
    await Promise.all([ensureOpenStudioLocationIndex(products), ensureOpenStudioLocationIndex(products)]);
    const local = connection.useDb(db.databaseName);
    const Model = local.model("SlotProduct", productSchema, "products");
    const payload = { tenant, location, createdBy: new mongoose.Types.ObjectId(), name: "Original", type: "workshop", kind: "open-studio", price: 0, extraCharge: 0 } as const;
    await Model.create(payload);
    await expect(Model.create({ ...payload, name: "Another", isActive: false })).rejects.toMatchObject({ code: 11000 });
  });

  it.each([
    { kind: "invalid", type: "workshop" },
    { kind: " OPEN-STUDIO ", type: "workshop" },
    { type: " PUBLIC-WORKSHOP " },
    { kind: "open-studio", location: String(new mongoose.Types.ObjectId()) },
    { kind: "open-studio", isArchived: "false" },
  ])("reports normalized legacy or malformed scope fields before startup without modifying data: %j", async (malformed) => {
    const products = connection.getClient().db(`open-studio-${++number}`).collection("products");
    const tenant = new mongoose.Types.ObjectId();
    const location = new mongoose.Types.ObjectId();
    const id = (await products.insertOne({ tenant, location, ...malformed })).insertedId;
    await products.insertOne({ tenant, location, kind: "class", type: "workshop" });
    const before = await products.find({}).toArray();
    const taxonomyReview = await reportOpenStudioLocationTaxonomyReview(products);
    expect(taxonomyReview).toHaveLength(1);
    expect(taxonomyReview[0].productId).toBe(String(id));
    await expect(ensureOpenStudioLocationIndex(products)).rejects.toMatchObject({ code: "OPEN_STUDIO_TAXONOMY_REQUIRES_REVIEW", taxonomyReview });
    expect(await products.find({}).toArray()).toEqual(before);
    expect((await products.listIndexes().toArray()).some(({ name }) => name === OPEN_STUDIO_LOCATION_INDEX_NAME)).toBe(false);
  });
});
