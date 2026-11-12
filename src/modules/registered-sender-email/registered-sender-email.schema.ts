import mongoose from "mongoose";

import {
  EMAIL_REGEX,
  REGISTERED_SENDER_PROVIDER,
  REGISTERED_SENDER_PROVIDERS,
  SENDER_TEST_STATUSES,
} from "./registered-sender-email.constants.js";

const managedSenderTestDeliverySchema = new mongoose.Schema(
  {
    providerMessageId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
    },
    status: {
      type: String,
      enum: ["accepted", "delivered", "bounced", "complained"],
      default: "accepted",
    },
    eventKey: { type: String, trim: true, default: "", maxlength: 500 },
    eventAt: { type: Date, default: null },
    error: { type: String, trim: true, default: "", maxlength: 2_000 },
    acceptedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

export const registeredSenderEmailSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      immutable: true,
    },
    displayName: { type: String, trim: true, default: "" },
    // Legacy SMTP fields remain readable for rollback/migration only. Managed
    // delivery never selects them and new managed identities do not set them.
    smtpHost: { type: String, trim: true, default: "" },
    smtpPort: { type: Number, min: 1, max: 65535, default: null },
    smtpSecure: { type: Boolean, default: false },
    smtpUser: { type: String, trim: true, default: "" },
    encryptedSmtpPassword: { type: String, default: "", select: false },
    provider: {
      type: String,
      enum: REGISTERED_SENDER_PROVIDERS,
      default: "custom",
    },
    providerServerId: { type: Number, default: null, min: 1 },
    encryptedPostmarkServerToken: { type: String, default: "", select: false },
    providerProvisionedAt: { type: Date, default: null },
    providerProvisioningStatus: {
      type: String,
      enum: ["pending", "ready", "error"],
      default: "pending",
    },
    providerProvisioningError: {
      type: String,
      default: "",
      select: false,
      maxlength: 500,
    },
    providerProvisioningErrorCode: {
      type: String,
      trim: true,
      default: "",
      maxlength: 80,
    },
    providerProvisioningAttemptedAt: { type: Date, default: null },
    providerProvisioningAttemptId: {
      type: String,
      default: "",
      select: false,
      maxlength: 80,
    },
    replyToEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      match: EMAIL_REGEX,
    },
    pendingReplyToEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      match: EMAIL_REGEX,
    },
    replyToVerifiedAt: { type: Date, default: null },
    replyToVerificationCodeHash: {
      type: String,
      default: "",
      select: false,
      maxlength: 128,
    },
    replyToVerificationExpiresAt: { type: Date, default: null, select: false },
    replyToVerificationSentAt: { type: Date, default: null, select: false },
    replyToVerificationAttempts: {
      type: Number,
      default: 0,
      min: 0,
      select: false,
    },
    isDefault: { type: Boolean, default: false, index: true },
    lastTestedAt: { type: Date, default: null },
    lastTestStatus: {
      type: String,
      enum: SENDER_TEST_STATUSES,
      default: "untested",
    },
    lastTestError: { type: String, default: "", select: false },
    lastTestProviderMessageId: {
      type: String,
      trim: true,
      default: "",
      maxlength: 300,
      select: false,
    },
    lastTestRecipientEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
      match: EMAIL_REGEX,
      select: false,
    },
    // A small correlation window lets delayed Postmark status webhooks match a
    // test even when another test is requested before the first event arrives.
    managedTestCorrelations: {
      type: [managedSenderTestDeliverySchema],
      default: [],
      select: false,
    },
    note: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

registeredSenderEmailSchema.index({ tenant: 1, email: 1 }, { unique: true });
registeredSenderEmailSchema.index({ tenant: 1, createdBy: 1 });
registeredSenderEmailSchema.index({ tenant: 1, isActive: 1 });
registeredSenderEmailSchema.index(
  { tenant: 1, provider: 1 },
  {
    unique: true,
    partialFilterExpression: {
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
    },
  },
);
registeredSenderEmailSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
    },
  },
);
registeredSenderEmailSchema.index(
  { providerServerId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerServerId: { $type: "number" } },
  },
);
registeredSenderEmailSchema.index(
  { "managedTestCorrelations.providerMessageId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "managedTestCorrelations.providerMessageId": { $type: "string" },
    },
  },
);
registeredSenderEmailSchema.index(
  { tenant: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);
