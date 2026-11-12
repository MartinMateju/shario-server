import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import {
  migrateUserMemberNumbers,
  UserMemberNumberMigrationConflictError,
} from "@/modules/user/user-member-number.migration.js";

const apply = process.argv.includes("--apply");

try {
  await connectDB();
  const summary = await migrateUserMemberNumbers({ apply });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error("User member-number migration failed.", error);
  if (error instanceof UserMemberNumberMigrationConflictError) {
    console.error(JSON.stringify(error.summary, null, 2));
  }
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
