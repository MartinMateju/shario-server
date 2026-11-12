import mongoose from "mongoose";

import {
  ACCESS_CODE_AUDIT_ACTION,
  ACCESS_CODE_NOTIFICATION_CHANNEL,
  ACCESS_CODE_NOTIFICATION_STATUS,
  ACCESS_CODE_PROVIDER,
  ACCESS_CODE_SOURCE,
  ACCESS_CODE_STATUS,
  ACCESS_CODE_TYPE,
  DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD,
} from "./access-code.constants.js";

export const accessCodePoolSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      select: false,
    },
    lowStockThreshold: {
      type: Number,
      required: true,
      min: 0,
      max: 10_000,
      default: DEFAULT_ACCESS_CODE_LOW_STOCK_THRESHOLD,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    archivedAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

accessCodePoolSchema.pre("validate", function normalizePoolName() {
  this.name = String(this.name || "").trim();
  this.normalizedName = this.name.toLocaleLowerCase();
});
accessCodePoolSchema.index(
  { tenant: 1, location: 1, normalizedName: 1 },
  { unique: true, name: "uniq_access_code_pool_name" },
);
accessCodePoolSchema.index({ tenant: 1, location: 1, isActive: 1 });

export const accessCodeSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    isUsed: {
      type: Boolean,
      required: true,
      default: false,
      index: true,
    },

    usedCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    entryCode: {
      type: String,
      required: true,
      trim: true,
      select: false,
    },

    codeFingerprint: {
      type: String,
      trim: true,
      default: "",
      select: false,
    },

    codeHint: {
      type: String,
      trim: true,
      default: "••••",
      maxlength: 20,
    },

    label: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },

    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },

    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    validFrom: { type: Date, default: null, index: true },
    validUntil: { type: Date, default: null, index: true },

    canBeRepeated: {
      type: Boolean,
      required: true,
      default: false,
      index: true,
    },

    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },

    pool: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccessCodePool",
      default: null,
      index: true,
    },

    type: {
      type: String,
      enum: Object.values(ACCESS_CODE_TYPE),
      default: ACCESS_CODE_TYPE.SINGLE_BOOKING,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(ACCESS_CODE_STATUS),
      default: ACCESS_CODE_STATUS.DRAFT,
      index: true,
    },

    source: {
      type: String,
      enum: Object.values(ACCESS_CODE_SOURCE),
      default: ACCESS_CODE_SOURCE.MANUAL,
    },

    verifiedAt: { type: Date, default: null },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    retiredAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    emergencyReserveKey: {
      type: String,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

accessCodeSchema.index({ tenant: 1, location: 1, isUsed: 1, canBeRepeated: 1 });
accessCodeSchema.index({ tenant: 1, location: 1, usedCount: 1 });
accessCodeSchema.index({ tenant: 1, expiresAt: 1 });
accessCodeSchema.index({ tenant: 1, pool: 1, status: 1, type: 1 });
accessCodeSchema.index(
  { tenant: 1, pool: 1, codeFingerprint: 1 },
  {
    unique: true,
    name: "uniq_access_code_pool_fingerprint",
    partialFilterExpression: { codeFingerprint: { $gt: "" } },
  },
);
accessCodeSchema.index(
  { emergencyReserveKey: 1 },
  {
    unique: true,
    name: "uniq_active_emergency_access_code",
    partialFilterExpression: { emergencyReserveKey: { $type: "string" } },
  },
);

export const accessCodeAuditEventSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      required: true,
      index: true,
    },
    pool: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccessCodePool",
      required: true,
      index: true,
    },
    accessCode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccessCode",
      default: null,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: Object.values(ACCESS_CODE_AUDIT_ACTION),
      required: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: { type: String, trim: true, default: "", maxlength: 120 },
    userAgent: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

accessCodeAuditEventSchema.index({ tenant: 1, createdAt: -1 });
accessCodeAuditEventSchema.index({ tenant: 1, pool: 1, createdAt: -1 });
accessCodeAuditEventSchema.index({ tenant: 1, accessCode: 1, createdAt: -1 });

// Retain provider correlation when staff authorize a new booking occurrence.
// This stores inventory references, never the entry code or its ciphertext.
const accessCodeDeliveryHistorySchema = new mongoose.Schema(
  {
    transitionId: { type: String, default: "", maxlength: 120 },
    archivedAt: { type: Date, required: true },
    bookingStart: { type: Date, default: null },
    accessCode: { type: mongoose.Schema.Types.ObjectId, ref: "AccessCode" },
    status: {
      type: String,
      enum: Object.values(ACCESS_CODE_NOTIFICATION_STATUS),
      required: true,
    },
    attempt: { type: Number, default: 1 },
    claimToken: { type: String, default: "", maxlength: 120 },
    provider: {
      type: String,
      enum: [...Object.values(ACCESS_CODE_PROVIDER), ""],
      default: "",
    },
    providerAttemptStartedAt: { type: Date, default: null },
    recipientEmail: { type: String, default: "", trim: true, lowercase: true },
    providerMessageId: { type: String, default: "" },
    providerDeliveryStatus: {
      type: String,
      enum: ["", "delivered", "bounced", "complained"],
      default: "",
    },
    providerStatusAt: { type: Date, default: null },
    providerEventKey: { type: String, default: "", maxlength: 300 },
    sentAt: { type: Date, default: null },
  },
  { _id: false },
);

export const accessCodeNotificationSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },

    accessCode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccessCode",
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    channel: {
      type: String,
      enum: Object.values(ACCESS_CODE_NOTIFICATION_CHANNEL),
      default: ACCESS_CODE_NOTIFICATION_CHANNEL.EMAIL,
      required: true,
      index: true,
    },

    bookingStart: {
      type: Date,
      default: null,
      index: true,
    },

    claimToken: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },

    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    nextAttemptAt: {
      type: Date,
      default: null,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(ACCESS_CODE_NOTIFICATION_STATUS),
      default: ACCESS_CODE_NOTIFICATION_STATUS.PROCESSING,
      required: true,
      index: true,
    },

    attempt: {
      type: Number,
      default: 1,
      min: 1,
    },

    provider: {
      type: String,
      enum: [...Object.values(ACCESS_CODE_PROVIDER), ""],
      default: "",
    },

    providerAttemptStartedAt: { type: Date, default: null },
    recipientEmail: { type: String, default: "", trim: true, lowercase: true },
    providerDeliveryStatus: {
      type: String,
      enum: ["", "delivered", "bounced", "complained"],
      default: "",
    },
    providerStatusAt: { type: Date, default: null },
    providerEventKey: { type: String, default: "", maxlength: 300 },
    providerMessageId: {
      type: String,
      trim: true,
      default: "",
    },

    sentAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    errorMessage: {
      type: String,
      trim: true,
      default: "",
      maxlength: 1000,
    },
    deliveryHistory: { type: [accessCodeDeliveryHistorySchema], default: [] },
  },
  {
    timestamps: true,
  },
);

accessCodeNotificationSchema.index(
  { tenant: 1, booking: 1, channel: 1 },
  { unique: true },
);
accessCodeNotificationSchema.index({ tenant: 1, status: 1, createdAt: 1 });
accessCodeNotificationSchema.index({ provider: 1, providerMessageId: 1 });
accessCodeNotificationSchema.index({ "deliveryHistory.providerMessageId": 1 });
accessCodeNotificationSchema.index({ status: 1, leaseExpiresAt: 1 });
accessCodeNotificationSchema.index({ status: 1, nextAttemptAt: 1 });
accessCodeNotificationSchema.index({ tenant: 1, booking: 1 });
accessCodeNotificationSchema.index({ tenant: 1, booking: 1, bookingStart: 1 });
accessCodeNotificationSchema.index({ tenant: 1, accessCode: 1 });
accessCodeNotificationSchema.index({ tenant: 1, user: 1 });
