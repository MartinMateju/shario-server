import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import { migrateCouponValueSnapshots } from "@/modules/coupon/coupon-value-snapshot.migration.js";

const argumentValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
};

const apply = process.argv.includes("--apply");
const tenantId = argumentValue("tenant");
const rawBatchSize = argumentValue("batch-size");
const batchSize = rawBatchSize ? Number(rawBatchSize) : undefined;

try {
  await connectDB();
  const summary = await migrateCouponValueSnapshots({
    apply,
    tenantId,
    batchSize,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.invalid > 0) process.exitCode = 1;
} catch (error) {
  console.error("Coupon value snapshot migration failed.", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
