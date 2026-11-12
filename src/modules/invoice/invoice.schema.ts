import mongoose, { type Model, Schema } from "mongoose";

import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
} from "@/shared/money/currency.js";

import {
  INVOICE_DELIVERY_STATUS,
  INVOICE_DOCUMENT_STATUS,
  INVOICE_DOCUMENT_TYPE,
  INVOICE_LOCALE,
  INVOICE_PAYMENT_METHOD,
  INVOICE_PAYMENT_STATUS,
  INVOICE_SOURCE_KIND,
} from "./invoice.constants.js";
import type { InvoiceRecord } from "./invoice.types.js";

const addressSnapshotSchema = new Schema(
  {
    line1: { type: String, trim: true, default: "" },
    line2: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    postalCode: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    countryCode: { type: String, trim: true, uppercase: true, default: "" },
  },
  { _id: false },
);

const partySnapshotSchema = new Schema(
  {
    legalName: { type: String, trim: true, default: "" },
    tradingName: { type: String, trim: true, default: "" },
    firstname: { type: String, trim: true, default: "" },
    lastname: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    registrationNumber: { type: String, trim: true, default: "" },
    taxId: { type: String, trim: true, default: "" },
    vatId: { type: String, trim: true, default: "" },
    address: { type: addressSnapshotSchema, default: () => ({}) },
    bank: {
      accountName: { type: String, trim: true, default: "" },
      accountNumber: { type: String, trim: true, default: "" },
      iban: { type: String, trim: true, uppercase: true, default: "" },
      bic: { type: String, trim: true, uppercase: true, default: "" },
    },
  },
  { _id: false },
);

const invoiceLineSchema = new Schema(
  {
    originalLineId: { type: Schema.Types.ObjectId, default: null },
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    description: { type: String, trim: true, required: true, maxlength: 500 },
    sku: { type: String, trim: true, default: "", maxlength: 120 },
    quantity: { type: Number, required: true, min: 1 },
    unitGrossMinor: { type: Number, required: true, min: 0 },
    grossAmountMinor: { type: Number, required: true, min: 0 },
    netAmountMinor: { type: Number, required: true, min: 0 },
    taxAmountMinor: { type: Number, required: true, min: 0 },
    taxRateBps: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
      validate: {
        validator: Number.isSafeInteger,
        message: "Tax rate must be an integer number of basis points.",
      },
    },
    creditedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    creditedTaxAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    locationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Location" }],
      default: [],
    },
  },
  { _id: true },
);

const invoiceIssuanceLineSchema = new Schema(
  {
    description: { type: String, trim: true, required: true, maxlength: 500 },
    quantity: { type: Number, required: true, min: 1 },
    grossAmountMinor: { type: Number, required: true, min: 0 },
    taxRateBps: {
      type: Number,
      required: true,
      min: 0,
      max: 10000,
      validate: {
        validator: Number.isSafeInteger,
        message: "Tax rate must be an integer number of basis points.",
      },
    },
  },
  { _id: false },
);

const invoiceIssuanceSnapshotSchema = new Schema(
  {
    documentType: {
      type: String,
      enum: Object.values(INVOICE_DOCUMENT_TYPE),
      required: true,
    },
    number: { type: String, trim: true, uppercase: true, required: true },
    originalInvoiceNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    creditReason: { type: String, trim: true, default: "", maxlength: 1000 },
    locale: {
      type: String,
      enum: Object.values(INVOICE_LOCALE),
      required: true,
    },
    timezone: { type: String, trim: true, required: true, maxlength: 100 },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      uppercase: true,
      trim: true,
    },
    sellerSnapshot: { type: partySnapshotSchema, required: true },
    customerSnapshot: { type: partySnapshotSchema, required: true },
    lineItems: { type: [invoiceIssuanceLineSchema], required: true },
    netAmountMinor: { type: Number, required: true, min: 0 },
    taxAmountMinor: { type: Number, required: true, min: 0 },
    totalAmountMinor: { type: Number, required: true, min: 0 },
    issueDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    taxableSupplyDate: { type: Date, default: null },
  },
  { _id: false, strict: true },
);

const paymentAllocationSchema = new Schema(
  {
    method: {
      type: String,
      enum: Object.values(INVOICE_PAYMENT_METHOD),
      required: true,
    },
    amountMinor: { type: Number, required: true, min: 0 },
    providerReference: { type: String, trim: true, default: "" },
    idempotencyKey: {
      type: String,
      trim: true,
      default: "",
      maxlength: 128,
      immutable: true,
    },
    paidAt: { type: Date, required: true, default: Date.now },
    recordedAt: { type: Date, required: true, default: Date.now, immutable: true },
    recordedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reversalReason: { type: String, trim: true, default: "", maxlength: 1000 },
    reversalIdempotencyKey: {
      type: String,
      trim: true,
      default: "",
      maxlength: 128,
    },
  },
  { _id: true },
);

const deliveryEventSchema = new Schema(
  {
    status: {
      type: String,
      enum: Object.values(INVOICE_DELIVERY_STATUS),
      required: true,
    },
    recipient: { type: String, trim: true, lowercase: true, required: true },
    sentAt: { type: Date, default: Date.now },
    providerMessageId: { type: String, trim: true, default: "" },
    error: { type: String, trim: true, default: "", maxlength: 2000 },
    sentBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

export const invoiceSchema = new Schema<InvoiceRecord, Model<InvoiceRecord>>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    source: {
      kind: {
        type: String,
        enum: Object.values(INVOICE_SOURCE_KIND),
        required: true,
      },
      id: { type: Schema.Types.ObjectId, default: null },
      key: { type: String, trim: true, required: true },
    },
    documentType: {
      type: String,
      enum: Object.values(INVOICE_DOCUMENT_TYPE),
      required: true,
      default: INVOICE_DOCUMENT_TYPE.INVOICE,
      index: true,
    },
    documentStatus: {
      type: String,
      enum: Object.values(INVOICE_DOCUMENT_STATUS),
      required: true,
      default: INVOICE_DOCUMENT_STATUS.DRAFT,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(INVOICE_PAYMENT_STATUS),
      required: true,
      default: INVOICE_PAYMENT_STATUS.UNPAID,
      index: true,
    },
    customerUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
    originalInvoice: {
      type: Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
      index: true,
    },
    originalInvoiceNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      maxlength: 100,
    },
    creditReason: { type: String, trim: true, default: "", maxlength: 1000 },
    number: { type: String, trim: true, uppercase: true, default: null },
    series: { type: String, trim: true, uppercase: true, default: null },
    sequence: { type: Number, min: 1, default: null },
    locale: {
      type: String,
      enum: Object.values(INVOICE_LOCALE),
      default: INVOICE_LOCALE.CS,
    },
    timezone: { type: String, trim: true, default: "UTC", maxlength: 100 },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      uppercase: true,
      trim: true,
      default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
      immutable: true,
    },
    sellerSnapshot: { type: partySnapshotSchema, required: true },
    customerSnapshot: { type: partySnapshotSchema, required: true },
    lineItems: { type: [invoiceLineSchema], required: true, default: [] },
    locationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "Location" }],
      default: [],
      index: true,
    },
    netAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    taxAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    totalAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    amountPaidMinor: { type: Number, required: true, min: 0, default: 0 },
    amountDueMinor: { type: Number, required: true, min: 0, default: 0 },
    creditedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    issuanceSnapshot: {
      type: invoiceIssuanceSnapshotSchema,
      default: null,
      immutable: true,
    },
    paymentAllocations: { type: [paymentAllocationSchema], default: [] },
    stripe: {
      checkoutSessionId: { type: String, trim: true, default: "" },
      paymentIntentId: { type: String, trim: true, default: "" },
    },
    issueDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    taxableSupplyDate: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    automatic: { type: Boolean, default: false },
    requiresReview: { type: Boolean, default: false },
    issuanceAttempts: { type: Number, min: 0, default: 0 },
    issuanceError: { type: String, trim: true, default: "", maxlength: 2000 },
    automationAttempts: { type: Number, min: 0, default: 0 },
    automationLastAttemptAt: { type: Date, default: null },
    automationNextAttemptAt: { type: Date, default: null },
    automationError: { type: String, trim: true, default: "", maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    deliveryLog: { type: [deliveryEventSchema], default: [] },
    sendClaimToken: { type: String, trim: true, default: "" },
    sendClaimExpiresAt: { type: Date, default: null },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);

invoiceSchema.index(
  { tenant: 1, documentType: 1, "source.key": 1 },
  { unique: true },
);
invoiceSchema.index(
  { tenant: 1, series: 1, sequence: 1 },
  {
    unique: true,
    partialFilterExpression: {
      series: { $type: "string", $gt: "" },
      sequence: { $type: "number" },
    },
  },
);
invoiceSchema.index({ tenant: 1, documentStatus: 1, issueDate: -1 });
invoiceSchema.index({ tenant: 1, customerUser: 1, issueDate: -1 });
invoiceSchema.index({ tenant: 1, originalInvoice: 1, documentStatus: 1 });
invoiceSchema.index({
  automatic: 1,
  automationNextAttemptAt: 1,
  documentStatus: 1,
});
invoiceSchema.index(
  { tenant: 1, number: 1 },
  {
    unique: true,
    partialFilterExpression: { number: { $type: "string", $gt: "" } },
  },
);

export const InvoiceModel =
  (mongoose.models.Invoice as Model<InvoiceRecord> | undefined) ??
  mongoose.model<InvoiceRecord>("Invoice", invoiceSchema);

export default InvoiceModel;
