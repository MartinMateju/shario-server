import mongoose, { type InferSchemaType, type Model } from "mongoose";

import {
  DATA_IMPORT_DUPLICATE_STRATEGY,
  DATA_IMPORT_ENTITY,
  DATA_IMPORT_ROLLBACK_STATUS,
  DATA_IMPORT_STATUS,
} from "./data-import.constants.js";

const summarySchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0, min: 0 },
    valid: { type: Number, default: 0, min: 0 },
    warnings: { type: Number, default: 0, min: 0 },
    invalid: { type: Number, default: 0, min: 0 },
    duplicates: { type: Number, default: 0, min: 0 },
    toCreate: { type: Number, default: 0, min: 0 },
    toUpdate: { type: Number, default: 0, min: 0 },
    toSkip: { type: Number, default: 0, min: 0 },
    created: { type: Number, default: 0, min: 0 },
    updated: { type: Number, default: 0, min: 0 },
    skipped: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    memberNumberCollisions: { type: Number, default: 0, min: 0 },
    memberNumberReassignments: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const dataImportSessionSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      enum: Object.values(DATA_IMPORT_ENTITY),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(DATA_IMPORT_STATUS),
      default: DATA_IMPORT_STATUS.UPLOADED,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    originalFileName: { type: String, required: true, maxlength: 255 },
    fileType: { type: String, enum: ["csv", "xlsx"], required: true },
    fileHash: { type: String, required: true, maxlength: 64 },
    sheetName: { type: String, default: null, maxlength: 255 },
    headers: { type: [String], default: [] },
    suggestedMapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    mapping: { type: mongoose.Schema.Types.Mixed, default: null },
    validationRevision: { type: String, default: null, maxlength: 64 },
    credentialRowCount: { type: Number, default: 0, min: 0 },
    credentialImportConfirmed: { type: Boolean, default: false },
    credentialImportConfirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    credentialImportConfirmedAt: { type: Date, default: null },
    preserveImportedMemberNumbers: { type: Boolean, default: false },
    duplicateStrategy: {
      type: String,
      enum: Object.values(DATA_IMPORT_DUPLICATE_STRATEGY),
      default: DATA_IMPORT_DUPLICATE_STRATEGY.SKIP,
    },
    summary: { type: summarySchema, default: () => ({}) },
    queuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    queuedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    reportAvailableUntil: { type: Date, default: null },
    rollbackAvailableUntil: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
    claimToken: { type: String, default: null, select: false },
    lastError: {
      type: new mongoose.Schema(
        {
          code: { type: String, default: null },
          message: { type: String, default: null, maxlength: 1_000 },
        },
        { _id: false },
      ),
      default: null,
    },
    rollback: {
      type: new mongoose.Schema(
        {
          status: {
            type: String,
            enum: Object.values(DATA_IMPORT_ROLLBACK_STATUS),
            default: DATA_IMPORT_ROLLBACK_STATUS.UNAVAILABLE,
            required: true,
          },
          revision: { type: Number, default: 0, min: 0 },
          previewDigest: {
            type: String,
            default: null,
            maxlength: 64,
            select: false,
          },
          previewedAt: { type: Date, default: null },
          unavailableReason: { type: String, default: null, maxlength: 120 },
          requestedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
          },
          requestedAt: { type: Date, default: null },
          requestKey: { type: String, default: null, maxlength: 128 },
          requestPreviewToken: {
            type: String,
            default: null,
            maxlength: 64,
            select: false,
          },
          startedAt: { type: Date, default: null },
          completedAt: { type: Date, default: null },
          leaseExpiresAt: { type: Date, default: null },
          claimToken: { type: String, default: null, select: false },
          counters: {
            type: new mongoose.Schema(
              {
                eligible: { type: Number, default: 0, min: 0 },
                rolledBack: { type: Number, default: 0, min: 0 },
                restored: { type: Number, default: 0, min: 0 },
                archived: { type: Number, default: 0, min: 0 },
                compensated: { type: Number, default: 0, min: 0 },
                blocked: { type: Number, default: 0, min: 0 },
                failed: { type: Number, default: 0, min: 0 },
              },
              { _id: false },
            ),
            default: () => ({}),
          },
          lastError: {
            type: new mongoose.Schema(
              {
                code: { type: String, default: null, maxlength: 120 },
                message: { type: String, default: null, maxlength: 1_000 },
              },
              { _id: false },
            ),
            default: null,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: true },
);

dataImportSessionSchema.index(
  { tenant: 1, createdAt: -1 },
  { name: "tenant_1_createdAt_-1" },
);
dataImportSessionSchema.index(
  { tenant: 1, status: 1, updatedAt: -1 },
  { name: "tenant_1_status_1_updatedAt_-1" },
);

export type DataImportSession = InferSchemaType<typeof dataImportSessionSchema>;

type DataImportSessionModelType = Model<DataImportSession>;

const DataImportSessionModel =
  (mongoose.models.DataImportSession as
    DataImportSessionModelType | undefined) ??
  mongoose.model<DataImportSession, DataImportSessionModelType>(
    "DataImportSession",
    dataImportSessionSchema,
  );

export default DataImportSessionModel;
