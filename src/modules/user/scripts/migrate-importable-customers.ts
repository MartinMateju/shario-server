import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { migrateUserEmailIndex } from "@/modules/user/user-email-index.migration.js";

const apply = process.argv.includes("--apply");

try {
  await connectDB();
  const summary = await migrateUserEmailIndex({ apply });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error("Importable customer index migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
