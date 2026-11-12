import mongoose, { Schema } from "mongoose";

import { MEMBERSHIP_LEDGER_ENTRY_TYPE } from "./membership.constants.js";

const immutableReferenceSchema = new Schema(
  {
    type: { type: String, trim: true, maxlength: 80, default: "", immutable: true },
    id: { type: String, trim: true, maxlength: 160, default: "", immutable: true },
  },
  { _id: false, strict: true },
);

const timeAllocationSchema = new Schema({
  key: { type: String, required: true },
  periodKey: { type: String, required: true },
  kind: { type: String, enum: ["period", "carryover", "adjustment"], required: true },
  amount: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  expiresAt: { type: Date, required: true },
}, { _id: false, strict: true });

export const membershipEntitlementLedgerSchema = new Schema(
  {
    tenant: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    membership: { type: Schema.Types.ObjectId, ref: "UserMembership", required: true, immutable: true },
    benefitKey: { type: String, required: true, trim: true, lowercase: true, immutable: true },
    type: {
      type: String,
      enum: Object.values(MEMBERSHIP_LEDGER_ENTRY_TYPE),
      required: true,
      immutable: true,
    },
    amount: { type: Number, required: true, immutable: true, validate: Number.isSafeInteger },
    balanceAfter: { type: Number, required: true, min: 0, immutable: true },
    sequence: { type: Number, required: true, min: 1, immutable: true },
    reason: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    note: { type: String, trim: true, maxlength: 1000, default: "", immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    reference: { type: immutableReferenceSchema, default: () => ({}), immutable: true },
    relatedEntry: {
      type: Schema.Types.ObjectId,
      ref: "MembershipEntitlementLedger",
      default: null,
      immutable: true,
    },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 160, immutable: true },
    identityHash: { type: String, required: true, trim: true, immutable: true },
    expiresAt: { type: Date, default: null, immutable: true },
    timeAllocations: { type: [timeAllocationSchema], default: [], immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true },
);

membershipEntitlementLedgerSchema.index(
  { membership: 1, idempotencyKey: 1 },
  { unique: true },
);
membershipEntitlementLedgerSchema.index(
  { membership: 1, benefitKey: 1, sequence: 1 },
  { unique: true },
);
membershipEntitlementLedgerSchema.index(
  { relatedEntry: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { relatedEntry: { $type: "objectId" }, type: "reversal" },
  },
);
membershipEntitlementLedgerSchema.index({ tenant: 1, user: 1, createdAt: -1 });

const rejectMutation = function () {
  throw new Error("Membership entitlement ledger entries are append-only.");
};
membershipEntitlementLedgerSchema.pre("findOneAndUpdate", rejectMutation);
membershipEntitlementLedgerSchema.pre("updateOne", rejectMutation);
membershipEntitlementLedgerSchema.pre("updateMany", rejectMutation);
membershipEntitlementLedgerSchema.pre("replaceOne", rejectMutation);
membershipEntitlementLedgerSchema.pre("deleteOne", rejectMutation);
membershipEntitlementLedgerSchema.pre("deleteMany", rejectMutation);
membershipEntitlementLedgerSchema.pre("save", function protectExistingLedgerEntry() {
  if (!this.isNew) rejectMutation();
});
membershipEntitlementLedgerSchema.pre(
  "deleteOne",
  { document: true, query: false },
  rejectMutation,
);

type MembershipEntitlementLedgerRecord = mongoose.InferSchemaType<typeof membershipEntitlementLedgerSchema>;
export const MembershipEntitlementLedgerModel: mongoose.Model<MembershipEntitlementLedgerRecord> =
  (mongoose.models.MembershipEntitlementLedger as mongoose.Model<MembershipEntitlementLedgerRecord> | undefined) ??
  mongoose.model<MembershipEntitlementLedgerRecord>("MembershipEntitlementLedger", membershipEntitlementLedgerSchema);

export default MembershipEntitlementLedgerModel;
