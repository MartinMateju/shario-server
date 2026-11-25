import "dotenv/config";
import { writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import connectDB from "@/infrastructure/database/connect-db.js";
import {
  planTenantDomainActivation,
  serializeDomainActivationSnapshot,
} from "../tenant-domain-activation.js";

const args = process.argv.slice(2);
const value = (flag: string): string => {
  const index = args.indexOf(flag);
  const result = index < 0 ? "" : (args[index + 1] ?? "");
  if (!result || result.startsWith("--")) throw new Error(`Missing ${flag}.`);
  return result;
};

const main = async () => {
  const apply = args.includes("--apply");
  const tenantId = value("--tenant-id");
  const tenantSlug = value("--tenant-slug");
  const hostname = value("--hostname");
  if (!/^[a-f\d]{24}$/.test(tenantId))
    throw new Error("Use the exact lowercase tenant ObjectId.");
  if (apply && !args.includes("--confirm-domain-ready")) {
    throw new Error(
      "Apply requires --confirm-domain-ready after DNS/TLS, frontend host mapping, signed BFF, and authentication checks.",
    );
  }
  const snapshotPath = apply ? value("--snapshot") : undefined;
  // Raw collections avoid model hooks and implicit index creation while planning.
  mongoose.set("autoIndex", false);
  await connectDB();
  const collection = mongoose.connection.db!.collection("tenants");
  const tenant = await collection.findOne(
    { _id: new mongoose.Types.ObjectId(tenantId), slug: tenantSlug },
    { projection: { slug: 1, status: 1, plan: 1, planVersion: 1, domains: 1 } },
  );
  if (!tenant) throw new Error("Workspace ID and slug did not match.");
  const plan = planTenantDomainActivation({
    tenant: tenant as never,
    expectedTenantId: tenantId,
    expectedSlug: tenantSlug,
    hostname,
  });
  const otherOwner = await collection.findOne(
    { _id: { $ne: tenant._id }, "domains.hostname": hostname },
    { projection: { _id: 1 } },
  );
  if (otherOwner)
    throw new Error("The hostname is already assigned to another workspace.");
  console.log(
    serializeDomainActivationSnapshot({
      mode: apply ? "apply" : "plan",
      ...plan,
    }),
  );
  if (!apply || !plan.changed) return;

  const indexes = await collection.listIndexes().toArray();
  if (
    !indexes.some(
      (index) =>
        index.unique === true &&
        Object.keys(index.key).length === 1 &&
        index.key["domains.hostname"] === 1,
    )
  ) {
    throw new Error(
      "The unique tenant domain index must exist before activation.",
    );
  }
  await writeFile(
    snapshotPath!,
    serializeDomainActivationSnapshot({
      version: 1,
      createdAt: new Date(),
      ...plan,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const result = await collection.updateOne(
    {
      _id: tenant._id,
      slug: tenantSlug,
      status: "active",
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      domains: plan.previousDomains,
    },
    { $set: { domains: plan.nextDomains, updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1)
    throw new Error(
      "Workspace changed during planning; no domain update applied. Review and plan again.",
    );
  // The public configuration endpoint bypasses its cache. Other public routes
  // and each API instance's CORS decisions expire independently; a CLI cannot
  // invalidate those in-memory caches across instances.
  console.log(
    JSON.stringify({
      activated: hostname,
      tenantId,
      snapshotPath,
      waitForCachesSeconds: Math.max(
        60,
        Number(process.env.PUBLIC_TENANT_CACHE_TTL_SECONDS || 30),
      ),
    }),
  );
};

main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Custom-domain activation failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
