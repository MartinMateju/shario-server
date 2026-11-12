import mongoose, { Schema } from "mongoose";

const creditMutationOperationSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    targetUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    keyHash: { type: String, required: true, immutable: true },
    requestHash: { type: String, required: true, immutable: true },
    operation: {
      type: String,
      enum: ["add", "use", "refund", "admin_grant"],
      required: true,
      immutable: true,
    },
    currency: { type: String, required: true, immutable: true },
    resultingBalanceMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },
  },
  {
    collection: "credit_mutation_operations",
    timestamps: true,
    strict: true,
    versionKey: false,
  },
);

creditMutationOperationSchema.index(
  { tenant: 1, actor: 1, keyHash: 1 },
  { unique: true, name: "credit_mutation_actor_key_unique" },
);

export const CreditMutationOperationModel: mongoose.Model<any> =
  (mongoose.models.CreditMutationOperation as
    | mongoose.Model<any>
    | undefined) ??
  mongoose.model<any>("CreditMutationOperation", creditMutationOperationSchema);

export default CreditMutationOperationModel;
