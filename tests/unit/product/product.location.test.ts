import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Product } from "@/modules/product/product.model.js";
import { createProductRepository } from "@/modules/product/product.repository.js";
import { assertStudioProductLocation, getStudioProductLocationId, isStudioProduct } from "@/modules/product/product-location.policy.js";
import { toProductCatalogDto, toProductPublicDto } from "@/modules/product/product.utils.js";
import { productListQuerySchema, publicProductListQuerySchema } from "@/modules/product/product.validators.js";

const tenantId = new mongoose.Types.ObjectId();
const locationA = new mongoose.Types.ObjectId();
const locationB = new mongoose.Types.ObjectId();

describe("studio product location policy", () => {
  it("recognizes mapped legacy studio products and respects canonical overrides", () => {
    for (const type of ["workshop", "public-workshop", "private-workshop", "blocker"]) {
      expect(isStudioProduct({ type })).toBe(true);
      expect(() => assertStudioProductLocation({ type }, locationA)).toThrow();
      expect(() => assertStudioProductLocation({ type, location: locationA }, locationA)).not.toThrow();
      expect(() => assertStudioProductLocation({ type, location: locationA }, locationB)).toThrow();
    }
    expect(isStudioProduct({ kind: "class", type: "workshop" })).toBe(false);
    expect(() => assertStudioProductLocation({ kind: "voucher" }, locationB)).not.toThrow();
  });

  it("reads stored, populated and DTO location identifiers", () => {
    expect(getStudioProductLocationId({ location: locationA })).toBe(String(locationA));
    expect(getStudioProductLocationId({ location: { _id: locationA } })).toBe(String(locationA));
    expect(getStudioProductLocationId({ locationId: String(locationA) })).toBe(String(locationA));
    expect(getStudioProductLocationId({})).toBeNull();
  });

  it("does not allow public callers to include unassigned products", () => {
    expect(productListQuerySchema.parse({ locationId: String(locationA), includeUnassigned: "false" })).toMatchObject({ locationId: String(locationA), includeUnassigned: false });
    expect(publicProductListQuerySchema.parse({ locationId: String(locationA), includeUnassigned: "true" })).not.toHaveProperty("includeUnassigned");
    expect(() => publicProductListQuerySchema.parse({ locationId: "bad-id" })).toThrow();
  });
});

describe("studio catalog database isolation", () => {
  let mongo: MongoMemoryServer;
  const repository = createProductRepository({ tenantId });
  const names = (products: Array<{ name: string }>) => products.map(({ name }) => name).sort();

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Product.init();
    await Product.collection.insertMany([
      { tenant: tenantId, name: "A studio", type: "workshop", kind: "open-studio", location: locationA, isActive: true },
      { tenant: tenantId, name: "B studio", type: "workshop", kind: "open-studio", location: locationB, isActive: true },
      { tenant: tenantId, name: "Legacy A", type: "blocker", location: locationA, isActive: true },
      { tenant: tenantId, name: "Archived A", type: "workshop", location: locationA, isArchived: true, isActive: true },
      { tenant: tenantId, name: "Unassigned", type: "workshop", isActive: true },
      { tenant: tenantId, name: "Private B", type: "blocker", location: locationB, isActive: true },
      { tenant: tenantId, name: "Class", type: "course", kind: "class", isActive: true },
      { tenant: new mongoose.Types.ObjectId(), name: "Foreign", type: "workshop", location: locationA, isActive: true },
    ]);
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it("filters both rows and counts by location while keeping global classes", async () => {
    const filter = { locationId: String(locationA), isActive: true };
    expect(names(await repository.list(filter))).toEqual(["A studio", "Class", "Legacy A"]);
    expect(await repository.count(filter)).toBe(3);
    expect(names(await repository.list({ ...filter, search: "studio" }))).toEqual(["A studio"]);
  });

  it("exposes unassigned records for unrestricted administration only", async () => {
    expect(names(await repository.list({ locationId: String(locationA), includeUnassigned: true }))).toContain("Unassigned");
    const restricted = { allowedLocationIds: [String(locationA)], includeUnassigned: true };
    expect(names(await repository.list(restricted))).toEqual(["A studio", "Class", "Legacy A"]);
    expect(await repository.count(restricted)).toBe(3);
    expect(names(await repository.list({ allowedLocationIds: [] }))).toEqual(["Class"]);
  });

  it("excludes unassigned studio records from every public selection", async () => {
    expect(names(await repository.list({ assignedStudioOnly: true }))).toEqual(["A studio", "B studio", "Class", "Legacy A", "Private B"]);
    expect(names(await repository.list({ assignedStudioOnly: true, locationId: String(locationB), includeUnassigned: true }))).toEqual(["B studio", "Class", "Private B"]);
  });

  it("keeps location in management and public DTOs", async () => {
    const [product] = await repository.list({ search: "A studio" });
    const dto = toProductPublicDto(product);
    expect(dto.locationId).toBe(String(locationA));
    expect(toProductCatalogDto(product).locationId).toBe(String(locationA));
    expect(toProductCatalogDto(dto).locationId).toBe(String(locationA));
  });

  it("hides explicitly archived rows even with an inconsistent active flag, retaining by-ID history", async () => {
    expect(names(await repository.list({ isActive: true }))).not.toContain("Archived A");
    const archived = await Product.findOne({ name: "Archived A", tenant: tenantId });
    expect(await repository.findById(archived!._id)).toMatchObject({ name: "Archived A", isArchived: true });
  });

  it("permits independent names at different locations, but rejects duplicates at one location", async () => {
    const record = { tenant: tenantId, name: "Shared name", location: locationA };
    await Product.collection.insertOne({ ...record });
    await Product.collection.insertOne({ ...record, location: locationB });
    await expect(Product.collection.insertOne({ ...record })).rejects.toMatchObject({ code: 11000 });
    await Product.collection.insertOne({ tenant: tenantId, name: "Global name" });
    await expect(Product.collection.insertOne({ tenant: tenantId, name: "Global name", location: null })).rejects.toMatchObject({ code: 11000 });
  });
});
