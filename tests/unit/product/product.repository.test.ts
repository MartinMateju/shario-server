import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const makeQuery = (value: unknown) => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.sort = vi.fn(() => query);
    query.skip = vi.fn(() => query);
    query.limit = vi.fn(() => query);
    query.select = vi.fn(() => query);
    query.populate = vi.fn(() => query);
    query.session = vi.fn(() => query);
    query.lean = vi.fn(() => query);
    query.exec = vi.fn().mockResolvedValue(value);
    return query;
  };

  return {
    countDocuments: vi.fn(() => makeQuery(0)),
    create: vi.fn(),
    find: vi.fn(() => makeQuery([])),
    findOne: vi.fn(() => makeQuery(null)),
    findOneAndDelete: vi.fn(() => makeQuery(null)),
    findOneAndUpdate: vi.fn(() => makeQuery(null)),
    makeQuery,
  };
});

vi.mock("@/modules/product/product.model.js", () => ({
  Product: {
    countDocuments: mocks.countDocuments,
    create: mocks.create,
    find: mocks.find,
    findOne: mocks.findOne,
    findOneAndDelete: mocks.findOneAndDelete,
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));

import { createProductRepository } from "@/modules/product/product.repository.js";

describe("product repository tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.find.mockImplementation(() => mocks.makeQuery([]));
    mocks.findOne.mockImplementation(() => mocks.makeQuery(null));
    mocks.findOneAndDelete.mockImplementation(() => mocks.makeQuery(null));
    mocks.findOneAndUpdate.mockImplementation(() => mocks.makeQuery(null));
    mocks.countDocuments.mockImplementation(() => mocks.makeQuery(0));
  });

  it("scopes lists to one tenant and treats search text literally", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const repository = createProductRepository({ tenantId });

    await repository.list({
      types: ["course", "public-course"],
      isActive: false,
      search: "[clay].*",
      page: 1,
      limit: 20,
    });

    expect(mocks.find).toHaveBeenCalledWith({
      tenant: tenantId,
      isArchived: { $ne: true },
      type: {
        $in: ["course", "public-course"],
      },
      isActive: false,
      $or: [
        {
          name: {
            $regex: "\\[clay\\]\\.\\*",
            $options: "i",
          },
        },
        {
          sku: {
            $regex: "\\[clay\\]\\.\\*",
            $options: "i",
          },
        },
        {
          classCategory: {
            $regex: "\\[clay\\]\\.\\*",
            $options: "i",
          },
        },
        {
          label: {
            $regex: "\\[clay\\]\\.\\*",
            $options: "i",
          },
        },
      ],
    });
  });

  it("applies publication scope to both catalog rows and counts before pagination while retaining legacy global courses", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const locationId = "507f1f77bcf86cd799439013";
    const repository = createProductRepository({ tenantId });
    const filters = { types: ["course"] as const, coursePublicationLocationId: locationId, page: 2, limit: 5 };
    await repository.list(filters);
    await repository.count(filters);
    const expected = { tenant: tenantId, isArchived: { $ne: true }, type: { $in: ["course"] }, $and: [{ $or: [{ "courseContent.locationIds.0": { $exists: false } }, { "courseContent.locationIds": locationId }] }] };
    expect(mocks.find).toHaveBeenCalledWith(expected);
    expect(mocks.countDocuments).toHaveBeenCalledWith(expected);
  });

  it("adds tenant scope to update and delete filters", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const repository = createProductRepository({ tenantId });

    await repository.update({
      id: String(productId),
      name: "Renamed",
      classCategory: "Pottery wheel",
    });
    await repository.delete(productId);

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: productId,
        tenant: tenantId,
      },
      {
        $set: {
          name: "Renamed",
          classCategory: "Pottery wheel",
        },
      },
      expect.objectContaining({
        returnDocument: "after",
        runValidators: true,
      }),
    );
    expect(mocks.findOneAndDelete).toHaveBeenCalledWith(
      {
        _id: productId,
        tenant: tenantId,
      },
      {},
    );
  });

  it("overrides caller-controlled ownership fields on creation", async () => {
    const tenantId = new mongoose.Types.ObjectId();
    const createdBy = new mongoose.Types.ObjectId();
    const repository = createProductRepository({ tenantId });
    mocks.create.mockResolvedValueOnce([{ _id: new mongoose.Types.ObjectId() }]);

    await repository.create(createdBy, {
      name: "Wheel basics",
      description: "",
      classCategory: "Pottery wheel",
      sku: "",
      type: "course",
      price: 100,
      extraCharge: 0,
      maxNumberOfParticipants: 4,
      imageSrc: "",
      label: "",
      voucherTemplate: "",
      isActive: true,
      sortOrder: 0,
    });

    expect(mocks.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenant: tenantId,
          createdBy,
          name: "Wheel basics",
          classCategory: "Pottery wheel",
        }),
      ],
      undefined,
    );
  });
});
