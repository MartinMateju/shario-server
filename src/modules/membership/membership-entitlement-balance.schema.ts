import mongoose, { Schema } from "mongoose";

const timeBucketSchema = new Schema({
  key: { type: String, required: true },
  periodKey: { type: String, required: true },
  kind: { type: String, enum: ["period", "carryover", "adjustment"], required: true },
  available: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  expiresAt: { type: Date, required: true },
}, { _id: false, strict: true });

export const membershipEntitlementBalanceSchema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserMembership", required: true, immutable: true },
    benefitKey: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    unit: { type: String, trim: true, default: "" },
    currency: { type: String, trim: true, uppercase: true, default: "" },
    granted: { type: Number, required: true, default: 0 },
    redeemed: { type: Number, required: true, default: 0, min: 0 },
    adjusted: { type: Number, required: true, default: 0 },
    expired: { type: Number, required: true, default: 0, min: 0 },
    available: { type: Number, required: true, default: 0, min: 0 },
    sequence: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, default: null, index: true },
    // Time balances retain the source/expiry of each spendable allocation.
    timeBucketVersion: { type: Number, default: 0 },
    timeBuckets: { type: [timeBucketSchema], default: [] },
    timePeriodKey: { type: String, default: "" },
    timePeriodStart: { type: Date, default: null },
    timePeriodEnd: { type: Date, default: null },
    timeGrantQuantity: { type: Number, min: 0, default: 0 },
    // Preserves unused base hours if expiry runs before a delayed paid invoice.
    rolloverCandidateAvailable: { type: Number, min: 0, default: null },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);

membershipEntitlementBalanceSchema.index(
  { membership: 1, benefitKey: 1 },
  { unique: true },
);
membershipEntitlementBalanceSchema.index({ tenant: 1, user: 1, updatedAt: -1 });

type MembershipEntitlementBalanceRecord = mongoose.InferSchemaType<typeof membershipEntitlementBalanceSchema>;
export const MembershipEntitlementBalanceModel: mongoose.Model<MembershipEntitlementBalanceRecord> =
  (mongoose.models.MembershipEntitlementBalance as mongoose.Model<MembershipEntitlementBalanceRecord> | undefined) ??
  mongoose.model<MembershipEntitlementBalanceRecord>("MembershipEntitlementBalance", membershipEntitlementBalanceSchema);

export default MembershipEntitlementBalanceModel;
