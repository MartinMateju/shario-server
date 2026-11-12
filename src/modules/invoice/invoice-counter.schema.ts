import mongoose, { type Model, Schema } from "mongoose";

import { INVOICE_DOCUMENT_TYPE } from "./invoice.constants.js";
import type { InvoiceCounterRecord } from "./invoice.types.js";

export const invoiceCounterSchema = new Schema<
  InvoiceCounterRecord,
  Model<InvoiceCounterRecord>
>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    documentType: {
      type: String,
      enum: Object.values(INVOICE_DOCUMENT_TYPE),
      required: true,
      immutable: true,
    },
    series: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      immutable: true,
      maxlength: 40,
    },
    sequence: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true, strict: true },
);

invoiceCounterSchema.index(
  { tenant: 1, documentType: 1, series: 1 },
  { unique: true },
);

export const InvoiceCounterModel =
  (mongoose.models.InvoiceCounter as Model<InvoiceCounterRecord> | undefined) ??
  mongoose.model<InvoiceCounterRecord>("InvoiceCounter", invoiceCounterSchema);

export default InvoiceCounterModel;
