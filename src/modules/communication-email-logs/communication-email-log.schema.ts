import mongoose from "mongoose";

import {
  COMMUNICATION_EMAIL_ALLOWANCE_CLASS,
  COMMUNICATION_EMAIL_ALLOWANCE_CLASS_VALUES,
  COMMUNICATION_EMAIL_LOG_STATUS_VALUES,
  COMMUNICATION_EMAIL_TYPE_VALUES,
  EMAIL_REGEX,
  isBuiltInLifecycleEmailLog,
} from "./communication-email-log.constants.js";

const providerLastEventSchema = new mongoose.Schema(
  {
    key: { type: String, default: "", maxlength: 300 },
    recordType: {
      type: String,
      enum: ["delivered", "bounced", "complained"],
      default: undefined,
    },
    at: { type: Date, default: null },
    providerEventId: { type: String, default: "", maxlength: 300 },
  },
  { _id: false },
);

export const communicationEmailLogSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    deduplicationKey: {
      type: String,
      default: "",
      trim: true,
      maxlength: 128,
    },
    occurrenceKey: {
      type: String,
      default: "",
      trim: true,
      maxlength: 240,
    },
    automation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommunicationAutomation",
      default: null,
      required: false,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
    },
    recipientName: { type: String, trim: true, default: "" },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    htmlContent: { type: String, default: "" },
    body: { type: String, default: "" },
    contentFormat: {
      type: String,
      enum: ["html", "plain"],
      default: "html",
    },
    locale: { type: String, enum: ["cs", "en"], default: "cs", index: true },
    purpose: {
      type: String,
      enum: ["transactional", "marketing", "security"],
      default: "transactional",
      index: true,
    },
    allowanceClass: {
      type: String,
      enum: COMMUNICATION_EMAIL_ALLOWANCE_CLASS_VALUES,
      default: COMMUNICATION_EMAIL_ALLOWANCE_CLASS.METERED,
      index: true,
    },
    emailType: {
      type: String,
      enum: COMMUNICATION_EMAIL_TYPE_VALUES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: COMMUNICATION_EMAIL_LOG_STATUS_VALUES,
      default: "pending",
      index: true,
    },
    scheduledFor: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    complainedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    queuedAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    processingJobId: { type: String, default: "", maxlength: 160 },
    processingClaimToken: { type: String, default: "", maxlength: 80 },
    processingLeaseExpiresAt: { type: Date, default: null },
    providerAttemptStartedAt: { type: Date, default: null },
    manualReviewRequiredAt: { type: Date, default: null },
    queueRecoveryAttempts: { type: Number, default: 0, min: 0 },
    nextQueueRecoveryAt: { type: Date, default: null },
    queueRecoveryClaimToken: { type: String, default: "", maxlength: 80 },
    queueRecoveryLeaseExpiresAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "", maxlength: 500 },
    sourceScheduledAt: { type: Date, default: null },
    sourceOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    sourceFiringItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    retryCycleStartAttempt: { type: Number, default: 0, min: 0 },
    manualRetryCount: { type: Number, default: 0, min: 0 },
    lastManualRetryAt: { type: Date, default: null },
    lastManualRetryBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    retryable: { type: Boolean, default: true },
    provider: { type: String, default: "", maxlength: 80 },
    providerMessageId: { type: String, default: "", maxlength: 500 },
    providerLastEvent: { type: providerLastEventSchema, default: undefined },
    errorMessage: {
      type: String,
      default: "",
      trim: true,
      maxlength: 3000,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },
    appliesToAllLocations: { type: Boolean, default: true, index: true },
    relatedEntityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    relatedEntityType: {
      type: String,
      default: "",
      trim: true,
      maxlength: 80,
    },
    senderEmail: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegisteredSenderEmail",
      default: null,
    },
  },
  { timestamps: true },
);

communicationEmailLogSchema.pre("validate", function normalizeContent() {
  const lifecycle = isBuiltInLifecycleEmailLog({
    emailType: this.emailType,
    automation: this.automation,
    purpose: this.purpose,
    allowanceClass: this.allowanceClass,
  });
  if (!lifecycle && !this.automation) {
    this.invalidate(
      "automation",
      "An automation is required for non-lifecycle emails.",
    );
  }
  const lifecycleType = [
    "bookingCancelled",
    "bookingRescheduled",
    "bookingExtended",
    "firingReady",
  ].includes(this.emailType);
  if (
    (lifecycleType || this.allowanceClass === "essential_system") &&
    !lifecycle
  ) {
    this.invalidate(
      "allowanceClass",
      "Only built-in lifecycle emails may use the essential system allowance.",
    );
  }
  if (!this.body && this.htmlContent) this.body = this.htmlContent;
  if (!this.htmlContent && this.body) this.htmlContent = this.body;
  if (this.appliesToAllLocations) this.location = null;
});

communicationEmailLogSchema.index({ tenant: 1, createdAt: -1 });
communicationEmailLogSchema.index({ tenant: 1, status: 1, createdAt: -1 });
communicationEmailLogSchema.index({ tenant: 1, emailType: 1, createdAt: -1 });
communicationEmailLogSchema.index({ tenant: 1, recipientEmail: 1 });
communicationEmailLogSchema.index({ tenant: 1, automation: 1 });
communicationEmailLogSchema.index({ tenant: 1, user: 1 });
communicationEmailLogSchema.index({ tenant: 1, relatedEntityId: 1 });
communicationEmailLogSchema.index({ tenant: 1, location: 1 });
communicationEmailLogSchema.index(
  { tenant: 1, deduplicationKey: 1 },
  {
    unique: true,
    partialFilterExpression: { deduplicationKey: { $type: "string", $gt: "" } },
  },
);
communicationEmailLogSchema.index({ provider: 1, providerMessageId: 1 });
communicationEmailLogSchema.index({ status: 1, scheduledFor: 1 });
communicationEmailLogSchema.index({ status: 1, processingLeaseExpiresAt: 1 });
communicationEmailLogSchema.index({ status: 1, nextQueueRecoveryAt: 1 });
communicationEmailLogSchema.index({ queueRecoveryLeaseExpiresAt: 1 });
