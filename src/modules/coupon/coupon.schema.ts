import mongoose from "mongoose";

import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  STUDIO_COMMERCE_CURRENCIES,
} from "@/shared/money/currency.js";

import {
  COUPON_STATUSES,
  COUPON_STATUS,
  PROMO_CODE_REGEX,
} from "./coupon.constants.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const couponImportMetadataSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    importKey: { type: String, required: true, maxlength: 160 },
    externalId: { type: String, default: undefined, maxlength: 120 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    lastMutationKey: { type: String, default: undefined, maxlength: 160 },
    note: { type: String, default: "", maxlength: 1_000 },
    importedAt: { type: Date, required: true },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { _id: false, strict: true },
);

export const statusChangeAuditSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    adminName: {
      type: String,
      required: true,
      trim: true,
    },

    adminEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
    },

    previousStatus: {
      type: String,
      required: true,
    },

    newStatus: {
      type: String,
      required: true,
    },

    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  { _id: false },
);

// Snapshots are written only from validated offering settings at purchase/issuance.
// Missing lifecycleVersion identifies legacy vouchers; never infer new terms for them.
export const voucherSettingsSnapshotSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true },
  type: { type: String, enum: ["value", "experience"], required: true },
  validity: {
    mode: { type: String, enum: ["months", "date", "none"], required: true },
    months: { type: Number, min: 1, validate: Number.isSafeInteger },
    date: { type: String },
  },
  experienceProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  experienceQuantity: { type: Number, min: 1, validate: Number.isSafeInteger },
  eligibleProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  physicalDelivery: {
    type: new mongoose.Schema({
      enabled: { type: Boolean, default: false },
      postageFeeMinor: { type: Number, min: 0, validate: Number.isSafeInteger, default: 0 },
    }, { _id: false, strict: true }),
    default: undefined,
  },
}, { _id: false, strict: true });

export const couponSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Product",
      index: true,
    },

    promoCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: PROMO_CODE_REGEX,
    },

    valueMinorSnapshot: {
      type: Number,
      default: null,
      min: 1,
      immutable: true,
      validate: (value: number | null) => value === null || Number.isSafeInteger(value),
    },

    currencySnapshot: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      default: null,
      uppercase: true,
      trim: true,
      immutable: true,
    },

    lifecycleVersion: { type: Number, enum: [1], default: undefined, immutable: true },
    voucherTypeSnapshot: {
      type: String, enum: ["value", "experience"], default: undefined, immutable: true,
    },
    voucherSettingsSnapshot: {
      type: voucherSettingsSnapshotSchema, default: undefined, immutable: true,
    },
    productNameSnapshot: { type: String, default: undefined, immutable: true },
    designSnapshot: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true },
    remainingValueMinor: { type: Number, default: undefined, min: 0, validate: Number.isSafeInteger },
    walletRedeemedValueMinor: {
      type: Number, default: null, min: 0,
      validate: (value: number | null) => value === null || Number.isSafeInteger(value),
    },
    remainingQuantity: { type: Number, default: undefined, min: 0, validate: Number.isSafeInteger },
    reservedValueMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    reservedQuantity: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    refundReviewRequired: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    revocationReason: { type: String, default: "", maxlength: 1000 },
    revocationOperationId: { type: String, default: undefined, maxlength: 160 },
    // List visibility only: archival never changes entitlement or redemption.
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    singleUse: {
      type: Boolean,
      default: true,
      index: true,
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    reservedAt: {
      type: Date,
      default: null,
      index: true,
    },

    reservedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    reservedOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },

    reservedUntil: {
      type: Date,
      default: null,
      index: true,
    },

    redeemedAt: {
      type: Date,
      default: null,
      index: true,
    },

    redeemedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CouponOrder",
      default: null,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    importMetadata: {
      type: couponImportMetadataSchema,
      default: undefined,
      select: false,
    },
  },
  { timestamps: true },
);

couponSchema.index({ tenant: 1, promoCode: 1 }, { unique: true });
couponSchema.index({ tenant: 1, product: 1 });
couponSchema.index({ tenant: 1, isActive: 1 });
couponSchema.index({ tenant: 1, reservedUntil: 1 });
couponSchema.index({ tenant: 1, reservedUntil: 1, redeemedAt: 1 });
couponSchema.index({ tenant: 1, reservedOrder: 1 });
couponSchema.index({ tenant: 1, reservedOrder: 1, promoCode: 1 });
couponSchema.index({ tenant: 1, order: 1 });
couponSchema.index({ tenant: 1, redeemedBy: 1 });
couponSchema.index({ tenant: 1, createdBy: 1 });
couponSchema.index(
  { tenant: 1, "importMetadata.externalId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.externalId": { $type: "string" },
    },
    name: "coupon_import_external_id_unique",
  },
);
couponSchema.index(
  { tenant: 1, "importMetadata.importKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.importKey": { $type: "string" },
    },
    name: "coupon_import_key_unique",
  },
);
couponSchema.index(
  { tenant: 1, "importMetadata.fingerprint": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.fingerprint": { $type: "string" },
    },
    name: "coupon_import_fingerprint_unique",
  },
);
couponSchema.index(
  { tenant: 1, "importMetadata.lastMutationKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.lastMutationKey": { $type: "string" },
    },
    name: "coupon_import_last_mutation_unique",
  },
);
couponSchema.pre("validate", function validateSnapshotPair() {
  const hasValue =
    this.valueMinorSnapshot !== null && this.valueMinorSnapshot !== undefined;
  const hasCurrency = Boolean(this.currencySnapshot);
  if (hasValue !== hasCurrency) {
    this.invalidate(
      "valueMinorSnapshot",
      "Voucher value and currency snapshots must be stored together.",
    );
  }
});

export const couponOrderSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },

    productNameSnapshot: {
      type: String,
      trim: true,
      default: "",
    },

    voucherTemplateKeySnapshot: {
      type: String,
      trim: true,
      default: "",
    },

    voucherSettingsSnapshot: {
      type: voucherSettingsSnapshotSchema, default: undefined, immutable: true,
    },
    designSnapshot: { type: mongoose.Schema.Types.Mixed, default: undefined, immutable: true },
    localeSnapshot: { type: String, default: undefined, immutable: true },
    giftMessageSnapshot: { type: String, default: "", maxlength: 240, immutable: true },
    purchaseOriginSnapshot: { type: String, default: undefined, maxlength: 2048, immutable: true },
    purchaseAccessNonce: { type: String, default: undefined, select: false, immutable: true },
    purchaseAccessTokenHash: { type: String, default: undefined, select: false, immutable: true },
    purchaseAccessExpiresAt: { type: Date, default: null, immutable: true },
    checkoutExpiresAt: { type: Date, default: null },
    deliveryResendGeneration: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    deliveryResendRequestedAt: { type: Date, default: null },
    deliveryResendDay: { type: String, default: "", maxlength: 10 },
    deliveryResendDayCount: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    adminEmailSkipped: { type: Boolean, default: false },
    adminEmailSkipReason: { type: String, default: "", maxlength: 1000 },
    validityTimezoneSnapshot: { type: String, default: undefined, immutable: true },
    paidAt: { type: Date, default: null },
    expiresAtSnapshot: { type: Date, default: null },
    issuanceOperationId: { type: String, default: undefined, maxlength: 160, immutable: true },
    refundState: { type: String, enum: ["none", "revoked", "manual_review"], default: "none" },
    refundFailureReviewRequired: { type: Boolean, default: false },
    refundedAmountMinor: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    refundReviewReason: { type: String, default: "", maxlength: 1000 },
    processedRefundEventIds: { type: [String], default: [] },

    unitPriceSnapshot: {
      type: Number,
      required: true,
      min: 0,
    },

    currencySnapshot: {
      type: String,
      required: true,
      enum: STUDIO_COMMERCE_CURRENCIES,
      default: DEFAULT_STUDIO_COMMERCE_CURRENCY,
      uppercase: true,
      trim: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },

    shippingFeeSnapshot: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    subtotalSnapshot: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    totalSnapshot: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    expectedAmountMinor: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    firstname: {
      type: String,
      trim: true,
      default: "",
    },

    lastname: {
      type: String,
      trim: true,
      default: "",
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      index: true,
    },

    sendPost: {
      type: Boolean,
      default: false,
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
      immutable: true,
      validate: (value: string) => value === "" || /^[A-Z]{2}$/.test(value),
    },

    dispatchedAt: { type: Date, default: null },
    dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    dispatchOperationId: { type: String, default: undefined, maxlength: 160 },

    street: {
      type: String,
      trim: true,
      default: "",
    },

    city: {
      type: String,
      trim: true,
      default: "",
    },

    postalCode: {
      type: String,
      trim: true,
      default: "",
    },

    note: {
      type: String,
      trim: true,
      default: "",
    },

    coupons: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Coupon",
        required: true,
      },
    ],

    promoCodesSnapshot: {
      type: [String],
      default: [],
    },

    status: {
      type: String,
      enum: COUPON_STATUSES,
      default: COUPON_STATUS.PENDING_PAYMENT,
      index: true,
    },

    isProcessing: {
      type: Boolean,
      default: false,
      index: true,
    },

    processingStartedAt: {
      type: Date,
      default: null,
    },

    processingLeaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    processedAt: {
      type: Date,
      default: null,
      index: true,
    },

    stripeSessionId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },

    stripeConnectedAccountId: {
      type: String,
      trim: true,
      default: "",
      immutable: true,
      index: true,
    },

    stripeLivemode: {
      type: Boolean,
      default: null,
    },

    stripePaymentIntentId: {
      type: String,
      trim: true,
      default: "",
    },

    processedStripeEventIds: {
      type: [String],
      default: [],
    },

    processingError: {
      type: String,
      default: "",
    },

    statusChangeAudit: {
      type: [statusChangeAuditSchema],
      default: [],
    },

    emailSent: {
      type: Boolean,
      default: false,
    },

    adminEmailSent: {
      type: Boolean,
      default: false,
    },

    adminEmailSentAt: {
      type: Date,
      default: null,
    },

    customerEmailSent: {
      type: Boolean,
      default: false,
    },

    customerEmailSentAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

couponOrderSchema.pre("validate", function normalizeTotals() {
  const quantity = Math.max(1, Number(this.quantity || 1));
  const unitPrice = Math.max(0, Number(this.unitPriceSnapshot || 0));
  const shippingFee = Math.max(0, Number(this.shippingFeeSnapshot || 0));

  this.quantity = quantity;
  this.currencySnapshot = String(
    this.currencySnapshot || DEFAULT_STUDIO_COMMERCE_CURRENCY,
  )
    .trim()
    .toUpperCase() as typeof this.currencySnapshot;
  this.subtotalSnapshot = unitPrice * quantity;
  this.totalSnapshot = this.subtotalSnapshot + shippingFee;
});

couponOrderSchema.index({ tenant: 1, createdAt: -1 });
couponOrderSchema.index({ tenant: 1, status: 1, createdAt: -1 });
couponOrderSchema.index({
  tenant: 1,
  isProcessing: 1,
  processingStartedAt: -1,
});
couponOrderSchema.index({ tenant: 1, email: 1, createdAt: -1 });
couponOrderSchema.index({ tenant: 1, product: 1 });
couponOrderSchema.index({ tenant: 1, createdBy: 1 });

couponOrderSchema.index(
  { tenant: 1, stripeSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      stripeSessionId: { $type: "string", $gt: "" },
    },
  },
);
couponOrderSchema.index({
  tenant: 1,
  stripeConnectedAccountId: 1,
  createdAt: -1,
});

couponOrderSchema.index({ tenant: 1, issuanceOperationId: 1 }, {
  unique: true,
  partialFilterExpression: { issuanceOperationId: { $type: "string" } },
});
