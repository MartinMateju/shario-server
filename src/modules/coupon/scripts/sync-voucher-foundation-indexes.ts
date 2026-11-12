import "dotenv/config";
import { setServers } from "node:dns";
import mongoose from "mongoose";
import { maintainVoucherFoundationIndexes } from "../voucher-indexes.js";

// Use the raw driver, not registered Mongoose models. In particular, a dry run
// must never trigger Mongoose autoCreate/autoIndex through model initialization.
const main = async () => {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply")) throw new Error("Usage: sync-voucher-foundation-indexes.ts [--apply]");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI environment variable is not defined.");
  const dnsServers = process.env.DNS_SERVERS?.split(",").map(value => value.trim()).filter(Boolean);
  if (dnsServers?.length) setServers(dnsServers);
  const client = new mongoose.mongo.MongoClient(process.env.MONGO_URI, { maxPoolSize: 2, serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const report = await maintainVoucherFoundationIndexes(client.db(), { apply: args.includes("--apply") });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.safeToApply || (args.includes("--apply") && !report.indexesReady)) process.exitCode = 1;
  } finally { await client.close(); }
};

main().catch(error => {
  // A partial application is safe to rerun: existing equivalent indexes remain
  // untouched and only missing definitions will be created next time.
  const code = (error as { code?: number }).code;
  console.error("Voucher index preflight/application failed.", {
    code,
    message: code === 11000 ? "Concurrent duplicate operations prevent a unique index. Reconcile duplicates, then rerun the dry run."
      : code === 85 || code === 86 ? "An index definition changed during application. Inspect conflicting index definitions, then rerun the dry run."
      : error instanceof Error && ["MONGO_URI environment variable is not defined.", "Usage: sync-voucher-foundation-indexes.ts [--apply]"].includes(error.message)
        ? error.message : "Inspect database connectivity/permissions and the reported error code. Connection details are omitted.",
    nextStep: "No indexes are dropped by this script. Inspect any reported conflict and rerun indexes:vouchers:plan before retrying --apply.",
  });
  process.exitCode = 1;
});
