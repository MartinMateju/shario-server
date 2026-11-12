import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import {
  deriveEffectiveTenantModules,
  materializeWorkspaceModuleSelections,
} from "@/modules/tenants/tenant-workspace-modules.js";
import type {
  TenantModules,
  TenantPlan,
  TenantWorkspaceModules,
} from "@/modules/tenants/tenant.types.js";

const shouldApply = process.argv.includes("--apply");

type LegacyTenant = {
  _id: mongoose.Types.ObjectId;
  plan: TenantPlan;
  planVersion?: number;
  modules?: Partial<TenantModules>;
  workspaceModules?: TenantWorkspaceModules;
  settings?: {
    navigation?: {
      hiddenGroups?: string[];
      hiddenItems?: string[];
    };
  };
};

const run = async (): Promise<void> => {
  await connectDB();
  const tenants = (await TenantModel.collection
    .find(
      {},
      {
        projection: {
          plan: 1,
          planVersion: 1,
          modules: 1,
          workspaceModules: 1,
          "settings.navigation": 1,
        },
      },
    )
    .toArray()) as LegacyTenant[];

  const summary = {
    mode: shouldApply ? "apply" : "dry-run",
    scanned: tenants.length,
    toMigrate: 0,
    migrated: 0,
    skippedInvalidPlan: [] as string[],
  };

  for (const tenant of tenants) {
    let config;
    try {
      config = getPlanConfig(tenant.plan, tenant.planVersion);
    } catch {
      summary.skippedInvalidPlan.push(String(tenant._id));
      continue;
    }

    const workspaceModules = materializeWorkspaceModuleSelections({
      entitlements: config.modules,
      modules: tenant.modules,
      workspaceModules: tenant.workspaceModules,
    });
    const navigation = {
      hiddenGroups: tenant.settings?.navigation?.hiddenGroups ?? [],
      hiddenItems: tenant.settings?.navigation?.hiddenItems ?? [],
    };
    const effectiveModules = deriveEffectiveTenantModules({
      plan: tenant.plan,
      planVersion: config.version,
      workspaceModules,
      legacyModules: tenant.modules,
    });
    const needsUpdate =
      JSON.stringify(workspaceModules) !==
        JSON.stringify(tenant.workspaceModules ?? {}) ||
      tenant.settings?.navigation === undefined ||
      JSON.stringify(effectiveModules) !== JSON.stringify(tenant.modules ?? {});
    if (!needsUpdate) continue;

    summary.toMigrate += 1;
    if (!shouldApply) continue;

    const result = await TenantModel.collection.updateOne(
      { _id: tenant._id },
      {
        $set: {
          workspaceModules,
          modules: effectiveModules,
          "settings.navigation": navigation,
        },
      },
    );
    summary.migrated += result.modifiedCount;
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.skippedInvalidPlan.length > 0) process.exitCode = 1;
};

try {
  await run();
} catch (error) {
  console.error("Workspace configuration migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
