import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureProductLocationNameIndex,
  PRODUCT_LOCATION_NAME_INDEX_KEY,
  PRODUCT_LOCATION_NAME_INDEX_OPTIONS,
} from "@/modules/product/product-location-name-index.js";

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let databaseNumber = 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  // Model initialization must not hide the deployed database's stale indexes.
  connection = await mongoose.createConnection(mongo.getUri(), { autoIndex: false }).asPromise();
}, 120_000);

afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});

const createFixture = async (legacyIndexName = "tenant_1_name_1") => {
  const db = connection.getClient().db(`product-name-index-${++databaseNumber}`);
  const products = db.collection("products");
  const tenant = new mongoose.Types.ObjectId();
  const locationA = new mongoose.Types.ObjectId();
  const locationB = new mongoose.Types.ObjectId();
  const productA = new mongoose.Types.ObjectId();
  const productB = new mongoose.Types.ObjectId();
  const unassignedProduct = new mongoose.Types.ObjectId();
  const createdAt = new Date("2025-01-01T12:00:00Z");

  // A schema deployment adds the new index without removing the old one.
  await products.createIndex({ tenant: 1, name: 1 }, { unique: true, name: legacyIndexName });
  await products.createIndex(PRODUCT_LOCATION_NAME_INDEX_KEY, PRODUCT_LOCATION_NAME_INDEX_OPTIONS);
  await products.createIndex({ tenant: 1, isActive: 1 }, { name: "product_listing" });
  await products.createIndex(
    { tenant: 1, "importMetadata.sourceSystem": 1, "importMetadata.externalId": 1 },
    {
      name: "product_import_identity",
      unique: true,
      partialFilterExpression: { "importMetadata.externalId": { $type: "string" } },
    },
  );
  await products.insertMany([
    { _id: productA, tenant, location: locationA, name: "Studio access", kind: "open-studio", price: 125, createdAt, updatedAt: createdAt },
    { _id: productB, tenant, location: locationB, name: "Different studio access", kind: "open-studio", price: 200, createdAt, updatedAt: createdAt },
    { _id: unassignedProduct, tenant, name: "Unassigned legacy studio", type: "workshop", price: 80, createdAt, updatedAt: createdAt },
  ]);
  await db.collection("locations").insertMany([
    { _id: locationA, tenant, name: "Location A" },
    { _id: locationB, tenant, name: "Location B" },
  ]);
  await db.collection("bookings").insertOne({
    tenant, location: locationB, bookingProduct: unassignedProduct,
    start: createdAt, end: new Date("2025-01-01T14:00:00Z"), paymentStatus: "CONFIRMED",
  });
  await db.collection("orders").insertOne({
    tenant, isPaid: true, totalAmountMinor: 8_000,
    lineItems: [{ product: unassignedProduct, description: "Purchased studio terms", unitAmountMinor: 8_000, locationIds: [locationB] }],
  });
  const snapshot = async () => Object.fromEntries(await Promise.all(
    ["products", "locations", "bookings", "orders"].map(async (name) => [name, await db.collection(name).find({}).sort({ _id: 1 }).toArray()]),
  ));
  return { db, products, tenant, locationA, locationB, productA, productB, unassignedProduct, snapshot };
};

describe("product location/name index deployment repair", () => {
  it("reproduces the stale-index failure, then repairs only indexes without assigning locations or changing purchase history", async () => {
    const fixture = await createFixture();
    const { products, tenant, locationB, productB, unassignedProduct, snapshot } = fixture;
    const before = await snapshot();
    const indexesBefore = await products.listIndexes().toArray();

    await expect(products.insertOne({ tenant, location: locationB, name: "Studio access" })).rejects.toMatchObject({
      code: 11000, keyPattern: { tenant: 1, name: 1 },
    });
    await expect(products.updateOne({ _id: productB }, { $set: { name: "Studio access", price: 999 } })).rejects.toMatchObject({
      code: 11000, keyPattern: { tenant: 1, name: 1 },
    });
    expect(await snapshot()).toEqual(before);

    await expect(ensureProductLocationNameIndex(products)).resolves.toEqual({ removedLegacyIndexes: ["tenant_1_name_1"] });
    expect(await snapshot()).toEqual(before);
    expect(await products.findOne({ _id: unassignedProduct })).not.toHaveProperty("location");
    expect(await products.listIndexes().toArray()).toEqual(indexesBefore.filter(({ name }) => name !== "tenant_1_name_1"));
  });

  it("allows cross-location creation and rename, but rejects same-location duplicates atomically", async () => {
    const { products, tenant, locationA, locationB, productB } = await createFixture();
    await ensureProductLocationNameIndex(products);

    await expect(products.updateOne({ _id: productB }, { $set: { name: "Studio access" } })).resolves.toMatchObject({ modifiedCount: 1 });
    await products.insertOne({ tenant, location: locationA, name: "Shared new name", price: 100 });
    await products.insertOne({ tenant, location: locationB, name: "Shared new name", price: 200 });
    await products.insertOne({ tenant: new mongoose.Types.ObjectId(), location: locationA, name: "Shared new name" });
    const before = await products.find({}).sort({ _id: 1 }).toArray();

    await expect(products.insertOne({ tenant, location: locationA, name: "Shared new name" })).rejects.toMatchObject({
      code: 11000, keyPattern: PRODUCT_LOCATION_NAME_INDEX_KEY,
    });
    await expect(products.updateOne({ _id: productB }, { $set: { name: "Shared new name", price: 999 } })).rejects.toMatchObject({
      code: 11000, keyPattern: PRODUCT_LOCATION_NAME_INDEX_KEY,
    });
    expect(await products.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it("treats missing and null locations as the same global name scope while retaining tenant isolation", async () => {
    const { products, tenant, locationA } = await createFixture();
    await ensureProductLocationNameIndex(products);
    await products.insertOne({ tenant, name: "Global missing first" });
    await products.insertOne({ tenant, location: null, name: "Global null first" });
    const before = await products.find({}).sort({ _id: 1 }).toArray();

    await expect(products.insertOne({ tenant, location: null, name: "Global missing first" })).rejects.toMatchObject({ code: 11000 });
    await expect(products.insertOne({ tenant, name: "Global null first" })).rejects.toMatchObject({ code: 11000 });
    expect(await products.find({}).sort({ _id: 1 }).toArray()).toEqual(before);

    await products.insertOne({ tenant, location: locationA, name: "Global missing first" });
    await products.insertOne({ tenant: new mongoose.Types.ObjectId(), name: "Global missing first" });
  });

  it("supports concurrent API startup calls and subsequent repeated startup without touching records", async () => {
    const { db, products, snapshot } = await createFixture();
    await products.dropIndex(PRODUCT_LOCATION_NAME_INDEX_OPTIONS.name);
    const before = await snapshot();
    const otherConnection = await mongoose.createConnection(mongo.getUri(db.databaseName), { autoIndex: false }).asPromise();
    try {
      const results = await Promise.all([
        ensureProductLocationNameIndex(products),
        ensureProductLocationNameIndex(otherConnection.db!.collection("products")),
        ensureProductLocationNameIndex(products),
      ]);
      expect(results.flatMap(({ removedLegacyIndexes }) => removedLegacyIndexes)).toEqual(["tenant_1_name_1"]);
      await expect(ensureProductLocationNameIndex(products)).resolves.toEqual({ removedLegacyIndexes: [] });
      expect((await products.listIndexes().toArray()).map(({ name }) => name)).not.toContain("tenant_1_name_1");
      expect(await snapshot()).toEqual(before);
    } finally {
      await otherConnection.close();
    }
  });

  it("recognizes the exact legacy unique definition even when its name differs", async () => {
    const { products, snapshot } = await createFixture("custom_old_product_name_unique");
    const before = await snapshot();
    await expect(ensureProductLocationNameIndex(products)).resolves.toEqual({ removedLegacyIndexes: ["custom_old_product_name_unique"] });
    expect(await snapshot()).toEqual(before);
  });

  it("preserves the old constraint and records if the replacement index cannot be created", async () => {
    const { products, tenant, locationB, snapshot } = await createFixture();
    await products.dropIndex(PRODUCT_LOCATION_NAME_INDEX_OPTIONS.name);
    await products.createIndex(PRODUCT_LOCATION_NAME_INDEX_KEY, { name: PRODUCT_LOCATION_NAME_INDEX_OPTIONS.name });
    const before = await snapshot();
    const indexesBefore = await products.listIndexes().toArray();

    await expect(ensureProductLocationNameIndex(products)).rejects.toMatchObject({ code: 86 });
    expect(await products.listIndexes().toArray()).toEqual(indexesBefore);
    await expect(products.insertOne({ tenant, location: locationB, name: "Studio access" })).rejects.toMatchObject({
      code: 11000, keyPattern: { tenant: 1, name: 1 },
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    { label: "sparse", options: { sparse: true } },
    { label: "partial", options: { partialFilterExpression: { name: { $type: "string" } } } },
    { label: "collated", options: { collation: { locale: "en", strength: 2 } } },
  ])("refuses a $label legacy index without removing it or changing records", async ({ options }) => {
    const { products, snapshot } = await createFixture();
    await products.dropIndex("tenant_1_name_1");
    await products.createIndex({ tenant: 1, name: 1 }, { unique: true, name: "unexpected_legacy_name", ...options });
    const before = await snapshot();
    const indexesBefore = await products.listIndexes().toArray();

    await expect(ensureProductLocationNameIndex(products)).rejects.toThrow("Unexpected options on legacy product-name index unexpected_legacy_name");
    expect(await products.listIndexes().toArray()).toEqual(indexesBefore);
    expect(await snapshot()).toEqual(before);
  });

  it("creates the canonical full unique index for an empty database and remains repeatable", async () => {
    const products = connection.getClient().db(`product-name-index-${++databaseNumber}`).collection("products");
    await expect(ensureProductLocationNameIndex(products)).resolves.toEqual({ removedLegacyIndexes: [] });
    await expect(ensureProductLocationNameIndex(products)).resolves.toEqual({ removedLegacyIndexes: [] });
    expect(await products.listIndexes().toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: PRODUCT_LOCATION_NAME_INDEX_KEY, ...PRODUCT_LOCATION_NAME_INDEX_OPTIONS }),
    ]));
    expect(await products.countDocuments()).toBe(0);
  });
});
