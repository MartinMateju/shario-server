import mongoose, { type InferSchemaType, type Model } from "mongoose";

import {
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_LIMITS,
  DATA_IMPORT_MUTATION_OPERATION,
  DATA_IMPORT_MUTATION_ROLLBACK_STATUS,
} from "./data-import.constants.js";

const fieldSnapshotSchema = new mongoose.Schema(
  {
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
    present: { type: [String], default: [] },
  },
  { _id: false, strict: true },
);

const dataImportMutationSchema = new mongoose.Schema(
  {
    schemaVersion: {
      type: Number,
      required: true,
      immutable: true,
      default: 1,
    },
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DataImportSession",
      required: true,
      immutable: true,
      index: true,
    },
    row: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DataImportRow",
      required: true,
      immutable: true,
      index: true,
    },
    rowNumber: { type: Number, required: true, immutable: true, min: 2 },
    entityType: {
      type: String,
      enum: Object.values(DATA_IMPORT_ENTITY),
      required: true,
      immutable: true,
    },
    mutationKey: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 200,
    },
    operation: {
      type: String,
      enum: Object.values(DATA_IMPORT_MUTATION_OPERATION),
      required: true,
      immutable: true,
    },
    importOutcome: {
      type: String,
      enum: ["created", "updated"],
      required: true,
      immutable: true,
    },
    importMessage: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 1_000,
    },
    isCanonicalResult: {
      type: Boolean,
      required: true,
      immutable: true,
      default: true,
    },
    target: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    targetUpdatedAt: { type: Date, default: null, immutable: true },
    affectedFields: {
      type: [String],
      required: true,
      immutable: true,
      default: [],
    },
    before: { type: fieldSnapshotSchema, required: true, immutable: true },
    after: { type: fieldSnapshotSchema, required: true, immutable: true },
    afterHash: { type: String, required: true, immutable: true, maxlength: 64 },
    payloadHash: {
      type: String,
      required: true,
      immutable: true,
      maxlength: 64,
    },
    delta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      immutable: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    rollback: {
      type: new mongoose.Schema(
        {
          status: {
            type: String,
            enum: Object.values(DATA_IMPORT_MUTATION_ROLLBACK_STATUS),
            default: DATA_IMPORT_MUTATION_ROLLBACK_STATUS.PENDING,
            required: true,
          },
          attemptId: { type: String, default: null, maxlength: 160 },
          claimToken: { type: String, default: null, select: false },
          leaseExpiresAt: { type: Date, default: null },
          reasonCode: { type: String, default: null, maxlength: 120 },
          message: { type: String, default: null, maxlength: 1_000 },
          startedAt: { type: Date, default: null },
          completedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    expiresAt: {
      type: Date,
      default: () =>
        new Date(
          Date.now() + DATA_IMPORT_LIMITS.ROW_RETENTION_DAYS * 86_400_000,
        ),
    },
  },
  { timestamps: true, strict: true },
);

dataImportMutationSchema.index(
  { tenant: 1, session: 1, row: 1, mutationKey: 1 },
  { unique: true, name: "tenant_session_row_mutation_unique" },
);
dataImportMutationSchema.index(
  { tenant: 1, session: 1, row: 1, isCanonicalResult: 1 },
  {
    unique: true,
    partialFilterExpression: { isCanonicalResult: true },
    name: "tenant_session_row_canonical_result_unique",
  },
);
dataImportMutationSchema.index(
  { tenant: 1, session: 1, "rollback.status": 1, rowNumber: -1 },
  { name: "tenant_session_rollback_status_order" },
);
dataImportMutationSchema.index(
  { tenant: 1, session: 1, rowNumber: -1, createdAt: -1 },
  { name: "tenant_session_rollback_order" },
);
dataImportMutationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type DataImportMutation = InferSchemaType<
  typeof dataImportMutationSchema
>;
type DataImportMutationModelType = Model<DataImportMutation>;

const DataImportMutationModel =
  (mongoose.models.DataImportMutation as
    DataImportMutationModelType | undefined) ??
  mongoose.model<DataImportMutation, DataImportMutationModelType>(
    "DataImportMutation",
    dataImportMutationSchema,
  );

export default DataImportMutationModel;
