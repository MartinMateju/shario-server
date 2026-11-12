import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

const creditImportAllocationSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    externalId: {
      type: String,
      default: undefined,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    fingerprint: {
      type: String,
      required: true,
      maxlength: 64,
      immutable: true,
    },
    importKey: {
      type: String,
      required: true,
      maxlength: 160,
      immutable: true,
    },
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    lastMutationKey: { type: String, default: undefined, maxlength: 160 },
    targetAmountMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      uppercase: true,
      trim: true,
      immutable: true,
    },
    revision: { type: Number, required: true, min: 1, default: 1 },
    note: { type: String, default: "", trim: true, maxlength: 1_000 },
    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);
creditImportAllocationSchema.index(
  { tenant: 1, user: 1 },
  { unique: true, name: "credit_import_allocation_user_unique" },
);
creditImportAllocationSchema.index(
  { tenant: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalId: { $type: "string" } },
    name: "credit_import_allocation_external_id_unique",
  },
);
creditImportAllocationSchema.index(
  { tenant: 1, importKey: 1 },
  { unique: true, name: "credit_import_allocation_import_key_unique" },
);
creditImportAllocationSchema.index(
  { tenant: 1, fingerprint: 1 },
  { unique: true, name: "credit_import_allocation_fingerprint_unique" },
);
creditImportAllocationSchema.index(
  { tenant: 1, lastMutationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { lastMutationKey: { $type: "string" } },
    name: "credit_import_allocation_last_mutation_unique",
  },
);
export type CreditImportAllocation = InferSchemaType<
  typeof creditImportAllocationSchema
>;
type CreditImportAllocationModelType = Model<CreditImportAllocation>;
export const CreditImportAllocationModel =
  (mongoose.models.CreditImportAllocation as
    CreditImportAllocationModelType | undefined) ??
  mongoose.model<CreditImportAllocation, CreditImportAllocationModelType>(
    "CreditImportAllocation",
    creditImportAllocationSchema,
  );
export default CreditImportAllocationModel;
