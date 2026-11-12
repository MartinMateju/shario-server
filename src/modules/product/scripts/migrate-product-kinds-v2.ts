import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { PRODUCT_KIND_CONTRACT_VERSION } from "@/modules/product/product-kind-v2.contract.js";
import {
  planProductKindV2Migration,
  type ProductKindMigrationDocument,
  type ProductKindMigrationPatch,
} from "@/modules/product/product-kind-v2.migration.js";

const apply = process.argv.includes("--apply");
const failOnManualReview = process.argv.includes("--fail-on-manual-review");

const value = (input: unknown): string => String(input ?? "").trim();

type ReviewRecord = {
  productId: string;
  tenantId: string;
  name: string;
  legacyType: string;
  existingKind: string;
  reason: string;
};

type SystemOwnedRecord = Omit<ReviewRecord, "existingKind">;

type MigrationCandidate = {
  productId: ProductKindMigrationDocument["_id"];
  legacyType: ProductKindMigrationDocument["type"];
  patch: ProductKindMigrationPatch;
};

const describeProduct = (product: ProductKindMigrationDocument) => ({
  productId: value(product._id),
  tenantId: value(product.tenant),
  name: value(product.name),
  legacyType: value(product.type),
  existingKind: value(product.kind),
});

const main = async (): Promise<void> => {
  await connectDB();

  const database = mongoose.connection.db;
  if (!database) throw new Error("MongoDB connection is unavailable.");

  const products = database.collection("products");
  const report = {
    migration: "product-kinds-v2",
    contractVersion: PRODUCT_KIND_CONTRACT_VERSION,
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    updateCandidates: 0,
    updated: 0,
    alreadyMigrated: 0,
    concurrentSkips: 0,
    manualReview: [] as ReviewRecord[],
    systemOwned: [] as SystemOwnedRecord[],
  };
  const candidates: MigrationCandidate[] = [];

  const cursor = products
    .find(
      {},
      {
        projection: {
          _id: 1,
          tenant: 1,
          name: 1,
          type: 1,
          kind: 1,
          kindContractVersion: 1,
          bookingMode: 1,
        },
      },
    )
    .sort({ _id: 1 });

  for await (const product of cursor) {
    report.scanned += 1;
    const plan = planProductKindV2Migration(product);
    const description = describeProduct(product);

    if (plan.action === "manual-review") {
      report.manualReview.push({
        ...description,
        reason: plan.reason,
      });
      continue;
    }

    if (plan.action === "system-owned") {
      const { existingKind: _existingKind, ...systemOwned } = description;
      report.systemOwned.push({
        ...systemOwned,
        reason: plan.reason,
      });
      continue;
    }

    if (plan.action === "already-migrated") {
      report.alreadyMigrated += 1;
      continue;
    }

    report.updateCandidates += 1;
    candidates.push({
      productId: product._id,
      legacyType: product.type,
      patch: plan.patch,
    });
  }

  const writeReport = (): void => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  };

  // This flag is a preflight gate: no product is updated when even one
  // ambiguous record remains. It lets operators fail a deployment safely
  // instead of discovering manual-review records after partial writes.
  if (failOnManualReview && report.manualReview.length > 0) {
    writeReport();
    throw new Error(
      `Product-kind migration requires manual review for ${report.manualReview.length} product(s).`,
    );
  }

  if (apply) {
    for (const candidate of candidates) {
      const baseFilter = {
        _id: candidate.productId,
        type: candidate.legacyType,
        $and: [
          {
            $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }],
          },
          ...(candidate.patch.bookingMode
            ? [
                {
                  $or: [
                    { bookingMode: { $exists: false } },
                    { bookingMode: null },
                    { bookingMode: "" },
                  ],
                },
              ]
            : []),
        ],
      };
      const result = await products.updateOne(baseFilter, {
        $set: candidate.patch,
      });

      if (result.modifiedCount === 1) report.updated += 1;
      else report.concurrentSkips += 1;
    }
  }

  writeReport();
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
