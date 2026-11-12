import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import connectDB from "@/infrastructure/database/connect-db.js";
import { migrateCommunicationEmailLogIdempotency } from "../communication-email-log-idempotency.migration.js";

try {
  await connectDB();
  const result = await migrateCommunicationEmailLogIdempotency();
  logger.info(result, "Communication email idempotency migration completed.");
} catch (error) {
  logger.error({ err: error }, "Communication email idempotency migration failed.");
  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
}
