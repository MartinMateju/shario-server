import mongoose, { Schema } from "mongoose";

import {
  TENANT_BILLING_EMAIL_LOCALE,
  TENANT_BILLING_EMAIL_STATUS,
  TENANT_BILLING_EMAIL_TYPE,
} from "./tenant-subscription.email.constants.js";
import type {
  TenantBillingEmailDelivery,
  TenantBillingEmailDeliveryModel as TenantBillingEmailDeliveryMongooseModel,
} from "./tenant-subscription.email.types.js";

const tenantBillingEmailPayloadSchema = new Schema(
  {
    recipientName: { type: String, required: true, trim: true },
    tenantName: { type: String, required: true, trim: true },
    billingUrl: { type: String, required: true, trim: true },
    timezone: { type: String, required: true, trim: true },
    trialEndsAt: String,
    graceEndsAt: String,
    nextPaymentAttemptAt: String,
    attemptCount: { type: Number, min: 0 },
  },
  { _id: false },
);

const tenantBillingEmailDeliverySchema = new Schema<
  TenantBillingEmailDelivery,
  TenantBillingEmailDeliveryMongooseModel
>(
  {
    deliveryKey: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      trim: true,
      maxlength: 300,
    },
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    type: {
      type: String,
      enum: Object.values(TENANT_BILLING_EMAIL_TYPE),
      required: true,
    },
    priority: {
      type: Number,
      required: true,
      default: 0,
    },
    recipient: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    locale: {
      type: String,
      enum: Object.values(TENANT_BILLING_EMAIL_LOCALE),
      required: true,
    },
    payload: {
      type: tenantBillingEmailPayloadSchema,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(TENANT_BILLING_EMAIL_STATUS),
      required: true,
      default: TENANT_BILLING_EMAIL_STATUS.PENDING,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    processingStartedAt: Date,
    sentAt: Date,
    providerMessageId: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    lastError: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true, strict: true },
);

tenantBillingEmailDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
tenantBillingEmailDeliverySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60 },
);

export const TenantBillingEmailDeliveryModel =
  (mongoose.models.TenantBillingEmailDelivery as
    TenantBillingEmailDeliveryMongooseModel | undefined) ??
  mongoose.model<
    TenantBillingEmailDelivery,
    TenantBillingEmailDeliveryMongooseModel
  >("TenantBillingEmailDelivery", tenantBillingEmailDeliverySchema);

export default TenantBillingEmailDeliveryModel;
