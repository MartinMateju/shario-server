import "dotenv/config";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import {
  ensureProductLocationNameIndex,
  PRODUCT_LOCATION_NAME_INDEX_KEY,
  PRODUCT_LOCATION_NAME_INDEX_OPTIONS,
} from "@/modules/product/product-location-name-index.js";
import {
  planProductLocationMigration,
  productLocationMigrationFilter,
  type ProductLocationMigrationDocument,
} from "@/modules/product/product-location.migration.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const failOnManualReview = args.includes("--fail-on-manual-review");
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);

type Assignment = { tenantId: string; productId: string; locationId: string };
const loadAssignments = async (path?: string): Promise<Map<string, Assignment>> => {
  const result = new Map<string, Assignment>();
  if (!path) return result;
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(input)) throw new Error("Assignments must be a JSON array of tenantId/productId/locationId objects.");
  for (const entry of input) {
    if (!validId(entry?.tenantId) || !validId(entry?.productId) || !validId(entry?.locationId)) {
      throw new Error("Every assignment requires valid tenantId, productId and locationId ObjectIds.");
    }
    if (result.has(entry.productId)) throw new Error(`Duplicate assignment for product ${entry.productId}.`);
    result.set(entry.productId, entry);
  }
  return result;
};

const main = async (): Promise<void> => {
  const tenantId = option("--tenant-id");
  if (tenantId && !validId(tenantId)) throw new Error("--tenant-id must be an ObjectId.");
  const assignments = await loadAssignments(option("--assignments"));
  mongoose.set("autoIndex", false);
  await connectDB();
  const database = mongoose.connection.db;
  if (!database) throw new Error("MongoDB connection is unavailable.");
  const products = database.collection("products");
  const tenantFilter = tenantId ? { tenant: new mongoose.Types.ObjectId(tenantId) } : {};
  const locationRows = await database.collection("locations").find(tenantFilter, {
    projection: { _id: 1, tenant: 1, isActive: 1 },
  }).toArray();
  const locations = locationRows.map((location) => ({ _id: location._id, tenant: location.tenant, isActive: location.isActive === true }));
  const report = {
    migration: "product-locations",
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    assigned: 0,
    alreadyAssigned: 0,
    concurrentSkips: 0,
    candidates: [] as Array<{ productId: string; tenantId: string; name: string; locationId: string; reason: string }>,
    manualReview: [] as Array<{ productId: string; tenantId: string; name: string; reason: string }>,
    indexes: { newUniqueIndex: PRODUCT_LOCATION_NAME_INDEX_OPTIONS.name, removedLegacyIndexes: [] as string[] },
  };
  const candidates: Array<{ product: ProductLocationMigrationDocument; locationId: string }> = [];
  const consumedAssignments = new Set<string>();
  for await (const product of products.find(tenantFilter, {
    projection: { _id: 1, tenant: 1, name: 1, kind: 1, type: 1, location: 1 },
  }).sort({ _id: 1 })) {
    report.scanned += 1;
    const description = { productId: String(product._id), tenantId: String(product.tenant), name: String(product.name ?? "") };
    const explicit = assignments.get(description.productId);
    if (explicit && explicit.tenantId !== description.tenantId) {
      throw new Error(`Assignment tenant does not match product ${description.productId}.`);
    }
    const document = product as ProductLocationMigrationDocument;
    // Skip nonstudio products before querying potentially large commerce collections.
    const preliminary = planProductLocationMigration({ product: document, locations, historicalLocationIds: [], explicitLocationId: explicit?.locationId });
    if (preliminary.action === "skip") {
      if (explicit) throw new Error(`Assignment refers to a nonstudio product ${description.productId}.`);
      continue;
    }
    if (explicit) consumedAssignments.add(description.productId);
    const bookingLocations = await database.collection("bookings").distinct("location", {
      tenant: product.tenant, bookingProduct: product._id,
    });
    // Use each matching line's locations, never all locations on a mixed-location order.
    const orderLocations = await database.collection("orders").aggregate<{ _id: unknown }>([
      { $match: { tenant: product.tenant, "lineItems.product": product._id } },
      { $unwind: "$lineItems" },
      { $match: { "lineItems.product": product._id } },
      { $unwind: "$lineItems.locationIds" },
      { $group: { _id: "$lineItems.locationIds" } },
    ]).toArray();
    const plan = planProductLocationMigration({
      product: document, locations,
      historicalLocationIds: [...bookingLocations, ...orderLocations.map((row) => row._id)],
      explicitLocationId: explicit?.locationId,
    });
    if (plan.action === "manual-review") report.manualReview.push({ ...description, reason: plan.reason });
    if (plan.action === "already-assigned") report.alreadyAssigned += 1;
    if (plan.action === "assign") {
      report.candidates.push({ ...description, locationId: plan.locationId, reason: plan.reason });
      candidates.push({ product: document, locationId: plan.locationId });
    }
  }
  for (const productId of assignments.keys()) {
    if (!consumedAssignments.has(productId)) throw new Error(`Assignment product ${productId} was not found in the selected scope.`);
  }
  const printReport = () => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failOnManualReview && report.manualReview.length) {
    printReport();
    throw new Error(`Resolve ${report.manualReview.length} studio product assignment(s) before applying.`);
  }
  if (apply) {
    // The replacement constraint exists before relaxing the old global name constraint.
    // This is collection-wide even when --tenant-id limits the data backfill.
    await products.createIndex(PRODUCT_LOCATION_NAME_INDEX_KEY, PRODUCT_LOCATION_NAME_INDEX_OPTIONS);
    for (const candidate of candidates) {
      const result = await products.updateOne(productLocationMigrationFilter(candidate.product), {
        $set: { location: new mongoose.Types.ObjectId(candidate.locationId) },
      });
      if (result.modifiedCount === 1) report.assigned += 1;
      else report.concurrentSkips += 1;
    }
    report.indexes.removedLegacyIndexes = (await ensureProductLocationNameIndex(products)).removedLegacyIndexes;
  }
  printReport();
  if (report.concurrentSkips) throw new Error("Some products changed during migration; rerun the dry-run before release.");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
