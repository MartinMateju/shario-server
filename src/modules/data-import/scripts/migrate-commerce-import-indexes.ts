import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { migrateCommerceImportIndexes } from "@/modules/data-import/commerce-import-index.migration.js";

const apply = process.argv.includes("--apply");

try {
  await connectDB();
  const summary = await migrateCommerceImportIndexes({ apply });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ready && apply) process.exitCode = 1;
} catch (error) {
  console.error("Commerce import index migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
