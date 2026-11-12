import mongoose from "mongoose";
import type { InferSchemaType, Model } from "mongoose";

export const COMMUNICATION_EMAIL_ALLOWANCE_STATUS = {
  RESERVED: "reserved",
  CONSUMED: "consumed",
  RELEASED: "released",
} as const;

const allowancePeriodSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
    },
    periodKey: { type: String, required: true, trim: true, maxlength: 80 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    limit: { type: Number, min: 0, required: true },
    reserved: { type: Number, min: 0, default: 0 },
    consumed: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true, strict: true },
);

allowancePeriodSchema.index({ tenant: 1, periodKey: 1 }, { unique: true });

const allowanceLedgerSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    periodKey: { type: String, required: true, trim: true, maxlength: 80 },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    emailLog: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationEmailLog",
      default: null,
    },
    status: {
      type: String,
      enum: Object.values(COMMUNICATION_EMAIL_ALLOWANCE_STATUS),
      default: COMMUNICATION_EMAIL_ALLOWANCE_STATUS.RESERVED,
      index: true,
    },
    consumedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true },
);

allowanceLedgerSchema.index(
  { tenant: 1, idempotencyKey: 1 },
  { unique: true },
);
allowanceLedgerSchema.index({ tenant: 1, periodKey: 1, createdAt: -1 });

type CommunicationEmailAllowancePeriod = InferSchemaType<
  typeof allowancePeriodSchema
>;
type CommunicationEmailAllowanceLedger = InferSchemaType<
  typeof allowanceLedgerSchema
>;
type CommunicationEmailAllowancePeriodModel =
  Model<CommunicationEmailAllowancePeriod>;
type CommunicationEmailAllowanceLedgerModel =
  Model<CommunicationEmailAllowanceLedger>;

export const CommunicationEmailAllowancePeriodModel =
  (mongoose.models.CommunicationEmailAllowancePeriod as
    | CommunicationEmailAllowancePeriodModel
    | undefined) ||
  mongoose.model<CommunicationEmailAllowancePeriod>(
    "CommunicationEmailAllowancePeriod",
    allowancePeriodSchema,
  );

export const CommunicationEmailAllowanceLedgerModel =
  (mongoose.models.CommunicationEmailAllowanceLedger as
    | CommunicationEmailAllowanceLedgerModel
    | undefined) ||
  mongoose.model<CommunicationEmailAllowanceLedger>(
    "CommunicationEmailAllowanceLedger",
    allowanceLedgerSchema,
  );
