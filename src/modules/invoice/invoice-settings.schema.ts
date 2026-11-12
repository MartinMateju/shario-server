import { DEFAULT_CREDIT_NOTE_PREFIX, DEFAULT_INVOICE_DUE_DAYS, DEFAULT_INVOICE_PREFIX, INVOICE_LOCALE } from "./invoice.constants.js";
import mongoose, { type Model, Schema } from "mongoose";

import type { InvoiceSettingsRecord } from "./invoice.types.js";

const addressSchema = new Schema(
  {
    line1: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },
    line2: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },
    city: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },
    postalCode: {
      type: String,
      trim: true,
      default: "",
      maxlength: 32,
    },
    country: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },
    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      maxlength: 2,
    },
  },
  {
    _id: false,
  },
);

export const invoiceSettingsSchema = new Schema<
  InvoiceSettingsRecord,
  Model<InvoiceSettingsRecord>
>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },

    legalName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },

    tradingName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },

    registrationNumber: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },

    taxId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },

    vatId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },

    address: {
      type: addressSchema,
      default: () => ({}),
    },

    contact: {
      email: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
        maxlength: 254,
      },
      phone: {
        type: String,
        trim: true,
        default: "",
        maxlength: 40,
      },
    },

    bank: {
      accountName: {
        type: String,
        trim: true,
        default: "",
        maxlength: 200,
      },
      accountNumber: {
        type: String,
        trim: true,
        default: "",
        maxlength: 100,
      },
      iban: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
        maxlength: 64,
      },
      bic: {
        type: String,
        trim: true,
        uppercase: true,
        default: "",
        maxlength: 32,
      },
    },

    locale: {
      type: String,
      enum: Object.values(INVOICE_LOCALE),
      default: INVOICE_LOCALE.CS,
    },

    defaultDueDays: {
      type: Number,
      min: 0,
      max: 365,
      default: DEFAULT_INVOICE_DUE_DAYS,
    },

    pricesIncludeTax: {
      type: Boolean,
      default: true,
    },

    defaultTaxRateBps: {
      type: Number,
      min: 0,
      max: 10000,
      default: 0,
    },

    invoicePrefix: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_INVOICE_PREFIX,
      maxlength: 20,
    },

    creditNotePrefix: {
      type: String,
      trim: true,
      uppercase: true,
      default: DEFAULT_CREDIT_NOTE_PREFIX,
      maxlength: 20,
    },

    autoCreatePaidOrderInvoices: {
      type: Boolean,
      default: true,
    },

    autoFinalizePaidOrderInvoices: {
      type: Boolean,
      default: false,
    },

    autoSendPaidOrderInvoices: {
      type: Boolean,
      default: false,
    },

    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

/*
 * One invoice-settings record per tenant.
 * This is the only declaration of the tenant index.
 */
invoiceSettingsSchema.index(
  { tenant: 1 },
  { unique: true },
);

export const InvoiceSettingsModel =
  (mongoose.models.InvoiceSettings as
    | Model<InvoiceSettingsRecord>
    | undefined) ??
  mongoose.model<InvoiceSettingsRecord>(
    "InvoiceSettings",
    invoiceSettingsSchema,
  );

export default InvoiceSettingsModel;
