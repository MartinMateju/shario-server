import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import { PRODUCT_KIND } from "@/modules/product/product-kind-v2.contract.js";
import { ProductClassCategoryModel } from "@/modules/product/product-class-category.model.js";
import {
  getProductClassCategoryNameKey,
  normalizeProductClassCategoryName,
} from "@/modules/product/product-class-category.utils.js";

const apply = process.argv.includes("--apply");

type BackfillCandidate = {
  tenant: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  name: string;
  nameKey: string;
  productCount: number;
  variants: Set<string>;
};

const value = (input: unknown): string => String(input ?? "").trim();

const main = async (): Promise<void> => {
  await connectDB();

  const database = mongoose.connection.db;
  if (!database) throw new Error("MongoDB connection is unavailable.");

  const report = {
    migration: "product-class-categories",
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    candidateCategories: 0,
    existingCategories: 0,
    synchronizedCategories: 0,
    createdCategories: 0,
    concurrentSkips: 0,
    normalizationCollisions: [] as Array<{
      tenantId: string;
      name: string;
      variants: string[];
      productCount: number;
    }>,
    manualReview: [] as Array<{
      productId: string;
      tenantId: string;
      name: string;
      reason: string;
    }>,
  };
  const candidates = new Map<string, BackfillCandidate>();
  const cursor = database.collection("products").find(
    {
      classCategory: { $type: "string", $ne: "" },
      $or: [
        { kind: PRODUCT_KIND.CLASS },
        { kind: { $exists: false }, type: { $in: COURSE_PRODUCT_TYPES } },
        { kind: null, type: { $in: COURSE_PRODUCT_TYPES } },
        { kind: "", type: { $in: COURSE_PRODUCT_TYPES } },
      ],
    },
    {
      projection: {
        _id: 1,
        tenant: 1,
        createdBy: 1,
        classCategory: 1,
      },
    },
  );

  for await (const product of cursor) {
    report.scanned += 1;
    const tenantId = value(product.tenant);
    const createdBy = value(product.createdBy);
    const name = normalizeProductClassCategoryName(product.classCategory);
    const nameKey = getProductClassCategoryNameKey(name);

    if (!tenantId || !createdBy || !name || !nameKey) {
      report.manualReview.push({
        productId: value(product._id),
        tenantId,
        name,
        reason: "Missing tenant, creator or usable category name.",
      });
      continue;
    }

    if (
      !mongoose.Types.ObjectId.isValid(tenantId) ||
      !mongoose.Types.ObjectId.isValid(createdBy)
    ) {
      report.manualReview.push({
        productId: value(product._id),
        tenantId,
        name,
        reason: "Invalid tenant or creator ObjectId.",
      });
      continue;
    }

    const groupKey = JSON.stringify([tenantId, nameKey]);
    const existing = candidates.get(groupKey);
    if (existing) {
      existing.productCount += 1;
      existing.variants.add(name);
      continue;
    }

    candidates.set(groupKey, {
      tenant: new mongoose.Types.ObjectId(tenantId),
      createdBy: new mongoose.Types.ObjectId(createdBy),
      name,
      nameKey,
      productCount: 1,
      variants: new Set([name]),
    });
  }

  for (const candidate of candidates.values()) {
    const existing = await ProductClassCategoryModel.exists({
      tenant: candidate.tenant,
      nameKey: candidate.nameKey,
    }).exec();

    if (existing) {
      report.existingCategories += 1;
      if (apply) {
        const result = await ProductClassCategoryModel.updateOne(
          {
            tenant: candidate.tenant,
            nameKey: candidate.nameKey,
            productCount: { $lt: candidate.productCount },
          },
          { $set: { productCount: candidate.productCount } },
        ).exec();
        if (result.modifiedCount === 1) report.synchronizedCategories += 1;
      }
      continue;
    }

    report.candidateCategories += 1;
    if (candidate.variants.size > 1) {
      report.normalizationCollisions.push({
        tenantId: String(candidate.tenant),
        name: candidate.name,
        variants: [...candidate.variants].sort(),
        productCount: candidate.productCount,
      });
    }

    if (!apply) continue;

    const result = await ProductClassCategoryModel.updateOne(
      {
        tenant: candidate.tenant,
        nameKey: candidate.nameKey,
      },
      {
        $setOnInsert: {
          tenant: candidate.tenant,
          createdBy: candidate.createdBy,
          name: candidate.name,
          nameKey: candidate.nameKey,
          productCount: candidate.productCount,
        },
      },
      { upsert: true },
    ).exec();

    if (result.upsertedCount === 1) report.createdCategories += 1;
    else report.concurrentSkips += 1;
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
