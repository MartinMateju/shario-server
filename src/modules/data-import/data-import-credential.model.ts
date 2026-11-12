import mongoose, { type InferSchemaType, type Model } from "mongoose";

const CREDENTIAL_RETENTION_MS = 24 * 60 * 60 * 1_000;

const dataImportCredentialSchema = new mongoose.Schema(
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
    sourceHeader: { type: String, required: true, maxlength: 120 },
    passwordHash: {
      type: String,
      required: true,
      minlength: 60,
      maxlength: 60,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + CREDENTIAL_RETENTION_MS),
    },
  },
  { timestamps: true },
);

dataImportCredentialSchema.index(
  { tenant: 1, session: 1, rowNumber: 1 },
  {
    unique: true,
    name: "tenant_1_session_1_rowNumber_1",
  },
);
dataImportCredentialSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type DataImportCredential = InferSchemaType<
  typeof dataImportCredentialSchema
>;

type DataImportCredentialModelType = Model<DataImportCredential>;

const DataImportCredentialModel =
  (mongoose.models.DataImportCredential as
    | DataImportCredentialModelType
    | undefined) ??
  mongoose.model<DataImportCredential, DataImportCredentialModelType>(
    "DataImportCredential",
    dataImportCredentialSchema,
  );

export default DataImportCredentialModel;
