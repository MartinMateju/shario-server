import mongoose, { Schema } from "mongoose";

export const membershipNotificationSchema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserMembership", required: true, immutable: true },
    intentKey: { type: String, required: true, trim: true, unique: true, immutable: true },
    type: { type: String, required: true, trim: true, immutable: true },
    recipient: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    subject: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
    html: { type: String, required: true, immutable: true },
    status: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending", index: true },
    attempts: { type: Number, min: 0, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    claimToken: { type: String, trim: true, default: "" },
    claimExpiresAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true, strict: true },
);

membershipNotificationSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

type MembershipNotificationRecord = mongoose.InferSchemaType<typeof membershipNotificationSchema>;
export const MembershipNotificationModel: mongoose.Model<MembershipNotificationRecord> =
  (mongoose.models.MembershipNotification as mongoose.Model<MembershipNotificationRecord> | undefined) ??
  mongoose.model<MembershipNotificationRecord>("MembershipNotification", membershipNotificationSchema);

export default MembershipNotificationModel;
