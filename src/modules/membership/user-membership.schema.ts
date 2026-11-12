import mongoose, { Schema } from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import { membershipBenefitTranslationsField, membershipTranslationsField } from "./membership.localization.js";
import {
  MEMBERSHIP_CANCELLATION_REASON,
  MEMBERSHIP_STATUS,
  OPEN_MEMBERSHIP_STATUSES,
} from "./membership.constants.js";

const snapshotPriceSchema = new Schema(
  {
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false },
);

const snapshotBenefitSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    translations: membershipBenefitTranslationsField(),
    type: { type: String, required: true },
    unit: { type: String, default: undefined },
    quantity: { type: Number, default: undefined },
    currency: { type: String, default: undefined },
    expiresAfterDays: { type: Number, default: undefined },
    adjustable: { type: Boolean, default: undefined },
    usageScope: { type: String, default: undefined },
    memberOnly: { type: Boolean, default: undefined },
    rolloverPercent: { type: Number, default: undefined },
    productScope: { type: String, default: undefined },
    eligibleProductIds: { type: [String], default: undefined },
    percentageBps: { type: Number, default: undefined },
    appliesTo: { type: String, default: undefined },
    limit: { type: Number, default: undefined },
    enabled: { type: Boolean, default: undefined },
  },
  { _id: false, strict: true },
);

const planSnapshotSchema = new Schema(
  {
    version: { type: Number, required: true, immutable: true },
    name: { type: String, required: true, immutable: true },
    description: { type: String, default: "", immutable: true },
    terms: { type: String, default: "", immutable: true },
    sourceLanguage: { type: String, enum: ROLLOUT_ELIGIBLE_APP_LOCALES, default: undefined, immutable: true },
    translations: { ...membershipTranslationsField(), immutable: true },
    prices: { type: [snapshotPriceSchema], required: true, immutable: true },
    billing: {
      type: { type: String, required: true, immutable: true },
      interval: { type: String, default: undefined, immutable: true },
      intervalCount: { type: Number, default: undefined, immutable: true },
      durationDays: { type: Number, default: undefined, immutable: true },
    },
    locationScope: {
      type: { type: String, required: true, immutable: true },
      locationIds: {
        type: [{ type: Schema.Types.ObjectId, ref: "Location" }],
        default: [],
        immutable: true,
      },
    },
    benefits: { type: [snapshotBenefitSchema], default: [], immutable: true },
  },
  { _id: false, strict: true },
);

const membershipImportMetadataSchema = new Schema(
  {
    source: { type: String, enum: ["csv", "xlsx"], required: true },
    importId: { type: String, required: true, maxlength: 64 },
    importKey: { type: String, required: true, maxlength: 160 },
    externalId: { type: String, default: undefined, maxlength: 120 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    allowanceTargets: {
      type: Map,
      of: { type: Number, min: 0, validate: Number.isSafeInteger },
      default: () => ({}),
    },
    allowanceRevision: { type: Number, min: 1, default: 1 },
    lastMutationKey: { type: String, default: undefined, maxlength: 160 },
    importedAt: { type: Date, required: true },
    importedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rolledBackAt: { type: Date, default: null },
    rolledBackBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rollbackMutationKey: { type: String, default: undefined, maxlength: 200 },
  },
  { _id: false, strict: true },
);

const planChangeSchema = new Schema({
  key: { type: String, required: true },
  requestKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ["preparing", "scheduled", "cancelling", "cancelled", "applied"], required: true },
  plan: { type: Schema.Types.ObjectId, required: true },
  planVersion: { type: Schema.Types.ObjectId, required: true },
  planSnapshot: { type: planSnapshotSchema, required: true },
  selectedLocation: { type: Schema.Types.ObjectId, default: null },
  currency: { type: String, required: true },
  amountMinor: { type: Number, required: true },
  effectiveAt: { type: Date, required: true },
  periodStart: { type: Date, required: true },
  requestedAt: { type: Date, required: true },
  termsAcceptedAt: { type: Date, required: true },
  locale: { type: String, required: true },
  stripePriceId: { type: String, default: "" },
  stripeScheduleId: { type: String, default: "" },
  oldStripePriceId: { type: String, default: "" },
  invoiceId: { type: String, default: "" },
  completedAt: { type: Date, default: null },
  previousPlan: { type: Schema.Types.ObjectId, default: null },
  previousPlanVersion: { type: Schema.Types.ObjectId, default: null },
  previousPlanSnapshot: { type: planSnapshotSchema, default: null },
  previousSelectedLocation: { type: Schema.Types.ObjectId, default: null },
  previousAmountMinor: { type: Number, default: null },
  previousTermsAcceptedAt: { type: Date, default: null },
  previousTermsAcceptedVersion: { type: Number, default: null },
}, { _id: false, strict: true });

export const userMembershipSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    plan: {
      type: Schema.Types.ObjectId,
      ref: "MembershipPlan",
      required: true,
      immutable: true,
      index: true,
    },
    planVersion: {
      type: Schema.Types.ObjectId,
      ref: "MembershipPlanVersion",
      required: true,
      immutable: true,
      index: true,
    },
    planSnapshot: { type: planSnapshotSchema, required: true, immutable: true },
    selectedLocation: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      immutable: true,
      index: true,
    },
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      required: true,
      immutable: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      immutable: true,
      validate: Number.isSafeInteger,
    },
    status: {
      type: String,
      enum: Object.values(MEMBERSHIP_STATUS),
      default: MEMBERSHIP_STATUS.PENDING,
      required: true,
      index: true,
    },
    isOpen: { type: Boolean, default: true, required: true, index: true },
    // Durable external-operation ownership: never expire an uncertain Stripe mutation.
    billingMutation: { type: String, default: null },
    scheduledPlanChange: { type: planChangeSchema, default: null },
    planChangeHistory: { type: [planChangeSchema], default: [], select: false },
    startedAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null, index: true },
    renewsAt: { type: Date, default: null, index: true },
    autoRenew: { type: Boolean, default: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelScheduledAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellation: {
      reason: {
        type: String,
        enum: Object.values(MEMBERSHIP_CANCELLATION_REASON),
        default: undefined,
      },
      comment: { type: String, trim: true, maxlength: 1000, default: "" },
      requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
      requestedAt: { type: Date, default: null },
      source: {
        type: String,
        enum: ["customer", "owner", "stripe", "system"],
        default: undefined,
      },
    },
    stripe: {
      connectedAccountId: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
      customerId: { type: String, trim: true, default: "", select: false },
      subscriptionId: { type: String, trim: true, default: "", select: false },
      checkoutSessionId: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
      checkoutIdempotencyKey: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
      checkoutRequestHash: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
      checkoutExpiresAt: {
        type: Number,
        min: 1,
        validate: Number.isSafeInteger,
        default: undefined,
        select: false,
      },
      lastEventCreated: { type: Number, min: 0, default: 0, select: false },
      lastEventId: { type: String, trim: true, default: "", select: false },
      lastSyncedAt: { type: Date, default: null },
    },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    assignmentSource: {
      type: String,
      enum: ["owner", "checkout", "migration"],
      default: "owner",
    },
    assignmentReason: { type: String, trim: true, default: "" },
    assignmentNote: { type: String, trim: true, maxlength: 1000, default: "" },
    termsAcceptedAt: { type: Date, default: null, immutable: true },
    termsAcceptedVersion: { type: Number, default: null, immutable: true },
    grantedPeriodKeys: {
      type: [String],
      default: [],
      select: false,
    },
    importMetadata: {
      type: membershipImportMetadataSchema,
      default: undefined,
      select: false,
    },
  },
  { timestamps: true, strict: true, optimisticConcurrency: true },
);

userMembershipSchema.pre("validate", function normalizeOpenState() {
  this.isOpen = (OPEN_MEMBERSHIP_STATUSES as readonly string[]).includes(
    this.status,
  );
  if (this.status === MEMBERSHIP_STATUS.CANCEL_SCHEDULED) {
    this.cancelAtPeriodEnd = true;
  }
});

// One pending/active/past-due/paused/scheduled membership across all plans.
userMembershipSchema.index(
  { tenant: 1, user: 1, isOpen: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } },
);
for (const [field, name] of [
  ["importKey", "user_membership_import_key_unique"],
  ["externalId", "user_membership_import_external_id_unique"],
  ["fingerprint", "user_membership_import_fingerprint_unique"],
] as const) {
  userMembershipSchema.index(
    { tenant: 1, [`importMetadata.${field}`]: 1 },
    {
      unique: true,
      partialFilterExpression: {
        [`importMetadata.${field}`]: { $type: "string" },
      },
      name,
    },
  );
}
userMembershipSchema.index(
  { tenant: 1, "importMetadata.lastMutationKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "importMetadata.lastMutationKey": { $type: "string" },
    },
    name: "user_membership_last_mutation_unique",
  },
);
userMembershipSchema.index({ tenant: 1, status: 1, currentPeriodEnd: 1 });
userMembershipSchema.index(
  { "stripe.connectedAccountId": 1, "stripe.subscriptionId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "stripe.connectedAccountId": { $type: "string", $gt: "" },
      "stripe.subscriptionId": { $type: "string", $gt: "" },
    },
  },
);
userMembershipSchema.index(
  { tenant: 1, "stripe.checkoutIdempotencyKey": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "stripe.checkoutIdempotencyKey": { $type: "string", $gt: "" },
    },
  },
);
