import mongoose, { type InferSchemaType, type Model } from "mongoose";

const dataImportAuditEventSchema = new mongoose.Schema(
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
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: [
        "uploaded",
        "validated",
        "queued",
        "completed",
        "failed",
        "rollback_requested",
        "rollback_started",
        "rollback_completed",
        "rollback_partial",
        "rollback_blocked",
        "rollback_failed",
      ],
      required: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

dataImportAuditEventSchema.index(
  { tenant: 1, session: 1, createdAt: 1 },
  { name: "tenant_1_session_1_createdAt_1" },
);

export type DataImportAuditEvent = InferSchemaType<
  typeof dataImportAuditEventSchema
>;

type DataImportAuditEventModelType = Model<DataImportAuditEvent>;

const DataImportAuditEventModel =
  (mongoose.models.DataImportAuditEvent as
    DataImportAuditEventModelType | undefined) ??
  mongoose.model<DataImportAuditEvent, DataImportAuditEventModelType>(
    "DataImportAuditEvent",
    dataImportAuditEventSchema,
  );

export default DataImportAuditEventModel;
