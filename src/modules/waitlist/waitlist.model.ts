import mongoose from "mongoose";

import {
  DEFAULT_APP_LOCALE,
  normalizeRolloutEligibleAppLocale,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
} from "@/shared/i18n/locales.js";

import {
  WAITLIST_EMAIL_TYPE,
  WAITLIST_STATE,
  WAITLIST_STATES,
  WAITLIST_TOKEN_PURPOSE,
} from "./waitlist.constants.js";

const { ObjectId } = mongoose.Schema.Types;

const rolloutLocaleField = () => ({
  type: String,
  enum: [...ROLLOUT_ELIGIBLE_APP_LOCALES],
  default: DEFAULT_APP_LOCALE,
  set: (value: unknown) => normalizeRolloutEligibleAppLocale(value) ?? value,
});

const priceSnapshotSchema = new mongoose.Schema(
  {
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    version: { type: String, required: true, trim: true, maxlength: 64 },
    productId: { type: ObjectId, ref: "Product", required: true },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
);

const waitlistEntrySchema = new mongoose.Schema(
  {
    tenant: { type: ObjectId, ref: "Tenant", required: true, index: true },
    courseSession: {
      type: ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    product: { type: ObjectId, ref: "Product", required: true, index: true },
    customer: { type: ObjectId, ref: "User", default: null, index: true },
    identityKey: { type: String, required: true, trim: true, maxlength: 64 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 320,
    },
    firstName: { type: String, required: true, trim: true, maxlength: 120 },
    lastName: { type: String, required: true, trim: true, maxlength: 120 },
    source: {
      type: String,
      enum: ["customer", "guest"],
      required: true,
    },
    locale: rolloutLocaleField(),
    emailVerifiedAt: { type: Date, required: true },
    state: {
      type: String,
      enum: WAITLIST_STATES,
      required: true,
      default: WAITLIST_STATE.WAITING,
      index: true,
    },
    isLive: { type: Boolean, required: true, default: true, index: true },
    sequence: { type: Number, required: true, min: 1 },
    joinedAt: { type: Date, required: true },
    sessionStartSnapshot: { type: Date, required: true },
    priceSnapshot: { type: priceSnapshotSchema, required: true },
    offerGeneration: { type: Number, required: true, default: 0, min: 0 },
    offerTokenHash: { type: String, default: "", select: false },
    offerExpiresAt: { type: Date, default: null, index: true },
    offeredAt: { type: Date, default: null },
    managementGeneration: { type: Number, required: true, default: 1, min: 1 },
    managementTokenHash: { type: String, required: true, select: false },
    managementExpiresAt: { type: Date, required: true },
    checkout: {
      orderId: { type: ObjectId, ref: "Order", default: null },
      stripeSessionId: { type: String, default: "", trim: true },
      expiresAt: { type: Date, default: null },
      reservationExpiresAt: { type: Date, default: null },
      startedAt: { type: Date, default: null },
      offerGeneration: { type: Number, default: null },
      fulfillmentClaimToken: { type: String, default: "", select: false },
      fulfillmentClaimExpiresAt: { type: Date, default: null },
    },
    confirmedAt: { type: Date, default: null },
    terminalAt: { type: Date, default: null },
    terminalReason: { type: String, default: "", trim: true, maxlength: 500 },
    refundSnapshot: {
      refundId: { type: String, default: "", trim: true },
      status: { type: String, default: "", trim: true },
      amountMinor: { type: Number, min: 0, default: null },
      currency: {
        type: String,
        default: "",
        trim: true,
        uppercase: true,
        maxlength: 3,
      },
      paymentMethod: { type: String, enum: ["card", ""], default: "" },
      refundedAt: { type: Date, default: null },
    },
    lastReconciledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

waitlistEntrySchema.index(
  { tenant: 1, courseSession: 1, identityKey: 1 },
  {
    unique: true,
    name: "waitlist_one_live_identity_per_session",
    partialFilterExpression: { isLive: true },
  },
);
waitlistEntrySchema.index(
  { tenant: 1, courseSession: 1, customer: 1 },
  {
    unique: true,
    name: "waitlist_one_live_customer_per_session",
    partialFilterExpression: { isLive: true, customer: { $type: "objectId" } },
  },
);
waitlistEntrySchema.index(
  { tenant: 1, courseSession: 1, sequence: 1 },
  { unique: true, name: "waitlist_fifo_sequence" },
);
waitlistEntrySchema.index({
  tenant: 1,
  courseSession: 1,
  state: 1,
  sequence: 1,
});
waitlistEntrySchema.index({ state: 1, offerExpiresAt: 1 });
waitlistEntrySchema.index({ state: 1, "checkout.expiresAt": 1 });
waitlistEntrySchema.index(
  { tenant: 1, managementTokenHash: 1 },
  {
    name: "waitlist_manage_token_lookup",
    partialFilterExpression: { managementTokenHash: { $type: "string" } },
  },
);
waitlistEntrySchema.index(
  { tenant: 1, offerTokenHash: 1 },
  {
    name: "waitlist_offer_token_lookup",
    partialFilterExpression: { offerTokenHash: { $type: "string", $gt: "" } },
  },
);
waitlistEntrySchema.index({ isLive: 1, lastReconciledAt: 1, _id: 1 });

const waitlistVerificationSchema = new mongoose.Schema(
  {
    tenant: { type: ObjectId, ref: "Tenant", required: true, index: true },
    courseSession: {
      type: ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    product: { type: ObjectId, ref: "Product", required: true },
    identityKey: { type: String, required: true, maxlength: 64 },
    email: { type: String, required: true, trim: true, lowercase: true },
    firstName: { type: String, required: true, trim: true, maxlength: 120 },
    lastName: { type: String, required: true, trim: true, maxlength: 120 },
    locale: rolloutLocaleField(),
    generation: { type: Number, required: true, default: 1 },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    entry: { type: ObjectId, ref: "WaitlistEntry", default: null },
    requestKey: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);
waitlistVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
waitlistVerificationSchema.index(
  { tenant: 1, tokenHash: 1 },
  { name: "waitlist_verification_token_lookup" },
);

const waitlistSequenceSchema = new mongoose.Schema(
  {
    tenant: { type: ObjectId, ref: "Tenant", required: true },
    courseSession: { type: ObjectId, ref: "Booking", required: true },
    next: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);
waitlistSequenceSchema.index(
  { tenant: 1, courseSession: 1 },
  { unique: true, name: "waitlist_sequence_per_session" },
);

const waitlistEmailOutboxSchema = new mongoose.Schema(
  {
    tenant: { type: ObjectId, ref: "Tenant", required: true, index: true },
    entry: { type: ObjectId, ref: "WaitlistEntry", default: null },
    verification: {
      type: ObjectId,
      ref: "WaitlistVerification",
      default: null,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    recipientName: { type: String, default: "", trim: true },
    type: {
      type: String,
      enum: Object.values(WAITLIST_EMAIL_TYPE),
      required: true,
    },
    tokenPurpose: {
      type: String,
      enum: [...Object.values(WAITLIST_TOKEN_PURPOSE), ""],
      default: "",
    },
    tokenGeneration: { type: Number, default: null },
    refundSnapshot: {
      refundId: { type: String, default: "", trim: true },
      status: { type: String, default: "", trim: true },
      amountMinor: { type: Number, min: 0, default: null },
      currency: {
        type: String,
        default: "",
        trim: true,
        uppercase: true,
        maxlength: 3,
      },
      paymentMethod: { type: String, enum: ["card", ""], default: "" },
      refundedAt: { type: Date, default: null },
    },
    deduplicationKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed", "skipped", "ambiguous"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    claimToken: { type: String, default: "", select: false },
    claimExpiresAt: { type: Date, default: null },
    providerAttemptStartedAt: { type: Date, default: null },
    providerMessageId: { type: String, default: "" },
    sentAt: { type: Date, default: null },
    lastError: { type: String, default: "", maxlength: 3000 },
  },
  { timestamps: true },
);
waitlistEmailOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

const waitlistAuditSchema = new mongoose.Schema(
  {
    tenant: { type: ObjectId, ref: "Tenant", required: true, index: true },
    courseSession: {
      type: ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    entry: { type: ObjectId, ref: "WaitlistEntry", default: null },
    actor: { type: ObjectId, ref: "User", required: true },
    action: {
      type: String,
      enum: [
        "settings_updated",
        "promoted",
        "offer_resent",
        "declined",
        "expired",
        "cancelled",
        "participant_removed",
      ],
      required: true,
    },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
    overrideFifo: { type: Boolean, default: false },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
waitlistAuditSchema.index({ tenant: 1, courseSession: 1, createdAt: -1 });

export const WaitlistEntryModel: mongoose.Model<any> =
  (mongoose.models.WaitlistEntry as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("WaitlistEntry", waitlistEntrySchema);
export const WaitlistVerificationModel: mongoose.Model<any> =
  (mongoose.models.WaitlistVerification as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("WaitlistVerification", waitlistVerificationSchema);
export const WaitlistSequenceModel: mongoose.Model<any> =
  (mongoose.models.WaitlistSequence as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("WaitlistSequence", waitlistSequenceSchema);
export const WaitlistEmailOutboxModel: mongoose.Model<any> =
  (mongoose.models.WaitlistEmailOutbox as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("WaitlistEmailOutbox", waitlistEmailOutboxSchema);
export const WaitlistAuditModel: mongoose.Model<any> =
  (mongoose.models.WaitlistAudit as mongoose.Model<any> | undefined) ??
  mongoose.model<any>("WaitlistAudit", waitlistAuditSchema);
