import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { buildLegacyWorkspaceIntentMigrationFilter } from "@/modules/tenants/tenant-workspace-intent.js";
import {
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_SOURCE,
} from "@/modules/tenants/tenant.constants.js";

const shouldApply = process.argv.includes("--apply");
const cutoffArgument = process.argv.find((value) =>
  value.startsWith("--cutoff="),
);
const cutoffValue = cutoffArgument?.slice("--cutoff=".length).trim();
const cutoff = cutoffValue ? new Date(cutoffValue) : null;

if (!cutoff || Number.isNaN(cutoff.getTime())) {
  throw new Error(
    "Provide a valid --cutoff=<ISO timestamp>. Only workspaces completed before that rollout boundary will be marked as legacy-confirmed.",
  );
}

type ExistingTenant = {
  _id: mongoose.Types.ObjectId;
  onboarding?: { completedAt?: Date };
  createdAt?: Date;
  updatedAt?: Date;
};

const run = async (): Promise<void> => {
  await connectDB();

  const filter = buildLegacyWorkspaceIntentMigrationFilter(cutoff);
  const tenants = (await TenantModel.collection
    .find(filter, {
      projection: {
        "onboarding.completedAt": 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    .toArray()) as ExistingTenant[];

  const summary = {
    mode: shouldApply ? "apply" : "dry-run",
    cutoff: cutoff.toISOString(),
    scanned: tenants.length,
    migrated: 0,
  };

  if (shouldApply) {
    for (const tenant of tenants) {
      const confirmedAt =
        tenant.onboarding?.completedAt ??
        tenant.createdAt ??
        tenant.updatedAt ??
        cutoff;
      const result = await TenantModel.collection.updateOne(
        {
          _id: tenant._id,
          workspaceIntent: { $exists: false },
        },
        {
          $set: {
            workspaceIntent: {
              definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
              confirmedAt,
              updatedAt: confirmedAt,
              source: TENANT_WORKSPACE_INTENT_SOURCE.LEGACY,
            },
          },
        },
      );
      summary.migrated += result.modifiedCount;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
};

try {
  await run();
} catch (error) {
  console.error("Workspace intent migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
