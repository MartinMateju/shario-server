import mongoose, { type InferSchemaType, type Model } from "mongoose";

import {
  DATA_IMPORT_LIMITS,
  DATA_IMPORT_ROW_STATUS,
} from "./data-import.constants.js";

const issueSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    field: { type: String, default: null },
    severity: { type: String, enum: ["warning", "error"], required: true },
    message: { type: String, required: true, maxlength: 500 },
  },
  { _id: false },
);

const dataImportRowSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    session: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DataImportSession",
      required: true,
      index: true,
    },
    rowNumber: { type: Number, required: true, min: 2 },
    raw: { type: mongoose.Schema.Types.Mixed, required: true },
    normalized: { type: mongoose.Schema.Types.Mixed, default: null },
    issues: { type: [issueSchema], default: [] },
    duplicate: {
      type: new mongoose.Schema(
        {
          kind: { type: String, default: null },
          existingUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
          },
          existingRecordId: {
            type: mongoose.Schema.Types.ObjectId,
            default: null,
          },
          rowNumber: { type: Number, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(DATA_IMPORT_ROW_STATUS),
      default: DATA_IMPORT_ROW_STATUS.PENDING,
      required: true,
    },
    resultUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    resultRecord: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    resultMessage: { type: String, default: null, maxlength: 1_000 },
    expiresAt: {
      type: Date,
      default: () =>
        new Date(
          Date.now() + DATA_IMPORT_LIMITS.ROW_RETENTION_DAYS * 86_400_000,
        ),
    },
  },
  { timestamps: true },
);

dataImportRowSchema.index(
  { tenant: 1, session: 1, rowNumber: 1 },
  { unique: true, name: "tenant_1_session_1_rowNumber_1" },
);
dataImportRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type DataImportRow = InferSchemaType<typeof dataImportRowSchema>;

type DataImportRowModelType = Model<DataImportRow>;

const DataImportRowModel =
  (mongoose.models.DataImportRow as DataImportRowModelType | undefined) ??
  mongoose.model<DataImportRow, DataImportRowModelType>(
    "DataImportRow",
    dataImportRowSchema,
  );

export default DataImportRowModel;
