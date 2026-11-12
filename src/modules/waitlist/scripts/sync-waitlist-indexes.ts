import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import Booking from "@/modules/booking/booking.model.js";
import { Order } from "@/modules/order/order.model.js";
import {
  WaitlistAuditModel,
  WaitlistEmailOutboxModel,
  WaitlistEntryModel,
  WaitlistSequenceModel,
  WaitlistVerificationModel,
} from "../waitlist.model.js";

const apply = process.argv.includes("--apply");

const models = [
  WaitlistEntryModel,
  WaitlistVerificationModel,
  WaitlistSequenceModel,
  WaitlistEmailOutboxModel,
  WaitlistAuditModel,
  Booking,
  Order,
];

const main = async () => {
  await connectDB();
  const report = {
    migration: "course-waitlist-indexes-v1",
    mode: apply ? "apply" : "dry-run",
    models: models.map((model) => ({
      model: model.modelName,
      collection: model.collection.collectionName,
      indexes: model.schema.indexes().map(([keys, options]) => ({
        keys,
        name: options.name ?? null,
        unique: options.unique === true,
        partialFilterExpression: options.partialFilterExpression ?? null,
      })),
    })),
  };

  if (apply) {
    // createIndexes is additive/idempotent. It deliberately does not drop any
    // existing production index; duplicate legacy data fails the deployment
    // before waitlists are enabled and must be reconciled explicitly.
    for (const model of models) await model.createIndexes();
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
