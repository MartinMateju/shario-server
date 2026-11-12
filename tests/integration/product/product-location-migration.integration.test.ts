import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, expect, it } from "vitest";

const exec = promisify(execFile);
let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let uri: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri("studio-location-migration-test");
  connection = await mongoose.createConnection(uri).asPromise();
}, 120_000);

afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});

it("dry-runs without writes, adds location in place, and preserves bookings and paid order snapshots", async () => {
  const db = connection.db!;
  const tenant = new mongoose.Types.ObjectId();
  const locationA = new mongoose.Types.ObjectId();
  const locationB = new mongoose.Types.ObjectId();
  const productId = new mongoose.Types.ObjectId();
  const ambiguousId = new mongoose.Types.ObjectId();
  const products = db.collection("products");
  await products.createIndex({ tenant: 1, name: 1 }, { unique: true });
  await db.collection("locations").insertMany([
    { _id: locationA, tenant, isActive: true },
    { _id: locationB, tenant, isActive: true },
  ]);
  await products.insertMany([
    { _id: productId, tenant, name: "Grohova access", kind: "open-studio", type: "workshop", price: 125, isActive: true },
    { _id: ambiguousId, tenant, name: "Shared old product", type: "workshop", price: 200 },
  ]);
  await db.collection("bookings").insertMany([
    { _id: new mongoose.Types.ObjectId(), tenant, bookingProduct: productId, location: locationA, start: new Date("2025-01-01"), paymentStatus: "CONFIRMED" },
    { _id: new mongoose.Types.ObjectId(), tenant, bookingProduct: ambiguousId, location: locationA },
    { _id: new mongoose.Types.ObjectId(), tenant, bookingProduct: ambiguousId, location: locationB },
  ]);
  await db.collection("orders").insertOne({
    tenant, isPaid: true, totalAmountMinor: 12_500,
    lineItems: [{ product: productId, description: "Original purchased description", unitAmountMinor: 12_500, locationIds: [locationA] }],
  });
  const beforeBookings = await db.collection("bookings").find({}).toArray();
  const beforeOrders = await db.collection("orders").find({}).toArray();
  const run = async (...args: string[]) => {
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/modules/product/scripts/migrate-product-locations.ts", ...args], {
      cwd: process.cwd(), env: { ...process.env, MONGO_URI: uri, NODE_ENV: "test" }, timeout: 30_000,
    });
    const report = stdout.match(/\{\n  "migration": "product-locations",[\s\S]*\n\}/)?.[0];
    expect(report).toBeTruthy();
    return JSON.parse(report!);
  };
  const dryRun = await run();
  expect(dryRun.candidates).toHaveLength(1);
  expect(dryRun.manualReview).toHaveLength(1);
  expect((await products.findOne({ _id: productId }))?.location).toBeUndefined();
  expect((await products.listIndexes().toArray()).some((index) => index.name === "tenant_1_name_1")).toBe(true);

  await expect(run("--apply", "--fail-on-manual-review")).rejects.toThrow();
  expect((await products.findOne({ _id: productId }))?.location).toBeUndefined();

  const applied = await run("--apply");
  expect(applied.assigned).toBe(1);
  expect(String((await products.findOne({ _id: productId }))?.location)).toBe(String(locationA));
  expect((await products.findOne({ _id: ambiguousId }))?.location).toBeUndefined();
  expect(await db.collection("bookings").find({}).toArray()).toEqual(beforeBookings);
  expect(await db.collection("orders").find({}).toArray()).toEqual(beforeOrders);
  expect((await run("--apply")).assigned).toBe(0);

  // Same name is allowed at a different location, but still unique at its own location.
  await products.insertOne({ tenant, name: "Grohova access", location: locationB });
  await expect(products.insertOne({ tenant, name: "Grohova access", location: locationA })).rejects.toMatchObject({ code: 11000 });
}, 120_000);
