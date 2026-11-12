import mongoose, { Schema } from "mongoose";

import { MEMBERSHIP_WEBHOOK_STATUS } from "./membership.constants.js";

export const membershipWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, trim: true, unique: true, immutable: true },
    eventType: { type: String, required: true, trim: true, immutable: true },
    eventCreated: { type: Number, required: true, min: 0, immutable: true },
    connectedAccountId: { type: String, required: true, trim: true, immutable: true },
    objectId: { type: String, trim: true, default: "", immutable: true },
    identityHash: { type: String, required: true, immutable: true },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_WEBHOOK_STATUS),
      default: MEMBERSHIP_WEBHOOK_STATUS.PENDING,
      required: true,
      index: true,
    },
    claimToken: { type: String, trim: true, default: "" },
    leaseExpiresAt: { type: Date, default: null, index: true },
    attempts: { type: Number, min: 0, default: 0 },
    processedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true, strict: true },
);

membershipWebhookEventSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });

type MembershipWebhookEventRecord = mongoose.InferSchemaType<typeof membershipWebhookEventSchema>;
export const MembershipWebhookEventModel: mongoose.Model<MembershipWebhookEventRecord> =
  (mongoose.models.MembershipWebhookEvent as mongoose.Model<MembershipWebhookEventRecord> | undefined) ??
  mongoose.model<MembershipWebhookEventRecord>("MembershipWebhookEvent", membershipWebhookEventSchema);

export default MembershipWebhookEventModel;
