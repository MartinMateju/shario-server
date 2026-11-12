import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { assertOpenStudioLocationAvailable } from "@/modules/product/open-studio-location.policy.js";
import { isOpenStudioLocationDuplicateError, OPEN_STUDIO_LOCATION_INDEX_KEY } from "@/modules/product/open-studio-location-index.js";
import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";

describe("Open Studio conflict contract", () => {
  it("returns a recoverable HTTP409 with tenant-scoped existing product and location", async () => {
    const productId = new mongoose.Types.ObjectId();
    const locationId = String(new mongoose.Types.ObjectId());
    const findOne = vi.fn().mockResolvedValue({ _id: productId });
    await expect(assertOpenStudioLocationAvailable({ repository: { findOne } as any, input: { kind: "open-studio", locationId } }))
      .rejects.toMatchObject({ statusCode: 409, code: "OPEN_STUDIO_ALREADY_EXISTS", details: { existingProductId: String(productId), locationId } });
    expect(findOne.mock.calls[0][0]).not.toHaveProperty("isActive");
  });

  it("excludes the edited product and retains a conflict after an atomic race even if the winner disappears", async () => {
    const id = new mongoose.Types.ObjectId();
    const location = new mongoose.Types.ObjectId();
    const findOne = vi.fn().mockResolvedValue(null);
    const params = { repository: { findOne } as any, input: { kind: "open-studio" }, existing: { _id: id, location } };
    await expect(assertOpenStudioLocationAvailable(params)).resolves.toBeUndefined();
    expect(findOne.mock.calls[0][0]).toMatchObject({ _id: { $ne: id }, location });
    await expect(assertOpenStudioLocationAvailable({ ...params, forceConflict: true })).rejects.toMatchObject({ code: "OPEN_STUDIO_ALREADY_EXISTS", details: { existingProductId: null, locationId: String(location) } });
  });

  it("does not confuse unrelated Mongo duplicate indexes with Open Studio conflicts", () => {
    expect(isOpenStudioLocationDuplicateError({ code: 11000, keyPattern: OPEN_STUDIO_LOCATION_INDEX_KEY })).toBe(true);
    expect(isOpenStudioLocationDuplicateError({ code: 11000, keyPattern: { tenant: 1, location: 1, name: 1 } })).toBe(false);
    expect(isOpenStudioLocationDuplicateError({ code: 11000, keyPattern: { tenant: 1, "importMetadata.importKey": 1 } })).toBe(false);
  });

  it("rejects archived studio products for new bookings independently of activity", () => {
    const location = new mongoose.Types.ObjectId();
    expect(() => assertStudioProductLocation({ kind: "open-studio", location, isArchived: true }, location)).toThrow(expect.objectContaining({ code: "PRODUCT_ARCHIVED" }));
  });
});
