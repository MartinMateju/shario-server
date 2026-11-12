import mongoose, { Schema } from "mongoose";

import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { getCurrentPlanVersion } from "@/modules/tenants/tenant.plan.js";
import { PLATFORM_BILLING_CURRENCIES } from "@/shared/money/currency.js";

import {
  BILLING_INTERVAL,
  PAYMENT_FAILURE_REASON,
  TENANT_SUBSCRIPTION_STATUS,
} from "./tenant-subscription.constants.js";
import type {
  TenantSubscription,
  TenantSubscriptionModel as TenantSubscriptionMongooseModel,
} from "./tenant-subscription.types.js";

const pendingChangeSchema = new Schema(
  {
    plan: {
      type: String,
      enum: Object.values(TENANT_PLAN),
      required: true,
    },
    planVersion: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    billingInterval: {
      type: String,
      enum: Object.values(BILLING_INTERVAL),
      required: true,
    },
    effectiveAt: {
      type: Date,
      required: true,
    },
  },
  {
    _id: false,
  },
);

export const tenantSubscriptionSchema = new Schema<
  TenantSubscription,
  TenantSubscriptionMongooseModel
>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      unique: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: Object.values(TENANT_SUBSCRIPTION_STATUS),
      default: TENANT_SUBSCRIPTION_STATUS.PENDING,
      required: true,
    },
    trialPlan: {
      type: String,
      enum: Object.values(TENANT_PLAN),
      default: TENANT_PLAN.PROFESSIONAL,
      required: true,
    },
    trialPlanVersion: {
      type: Number,
      default: () => getCurrentPlanVersion(TENANT_PLAN.PROFESSIONAL),
      required: true,
      min: 1,
    },
    billingPlan: {
      type: String,
      enum: Object.values(TENANT_PLAN),
      default: undefined,
    },
    planVersion: {
      type: Number,
      min: 1,
      default: undefined,
    },
    billingInterval: {
      type: String,
      enum: Object.values(BILLING_INTERVAL),
      default: undefined,
    },
    billingCurrency: {
      type: String,
      enum: PLATFORM_BILLING_CURRENCIES,
      uppercase: true,
      trim: true,
      default: undefined,
    },
    trialStartedAt: Date,
    trialEndsAt: Date,
    trialUsedAt: Date,
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    graceEndsAt: Date,
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    canceledAt: Date,
    endedAt: Date,
    pendingChange: {
      type: pendingChangeSchema,
      default: undefined,
    },
    stripe: {
      customerId: {
        type: String,
        trim: true,
        default: undefined,
      },
      subscriptionId: {
        type: String,
        trim: true,
        default: undefined,
      },
      subscriptionCreatedAt: {
        type: Number,
        min: 0,
        default: undefined,
      },
      priceId: {
        type: String,
        trim: true,
        default: undefined,
      },
      priceLookupKey: {
        type: String,
        trim: true,
        default: undefined,
      },
      offerId: {
        type: String,
        trim: true,
        default: undefined,
      },
      scheduleId: {
        type: String,
        trim: true,
        default: undefined,
      },
    },
    latestInvoiceId: {
      type: String,
      trim: true,
      default: undefined,
    },
    lastPaymentFailedAt: Date,
    paymentRetryCount: {
      type: Number,
      min: 0,
      default: undefined,
    },
    nextPaymentAttemptAt: Date,
    paymentRecoveryUrl: {
      type: String,
      trim: true,
      default: undefined,
    },
    paymentFailureReason: {
      type: String,
      enum: Object.values(PAYMENT_FAILURE_REASON),
      default: undefined,
    },
    lastPaymentEventCreatedAt: Number,
    lastWebhookEventId: {
      type: String,
      trim: true,
      default: undefined,
    },
    lastStripeEventCreatedAt: Number,
    lastSyncedAt: Date,
  },
  {
    timestamps: true,
    strict: true,
  },
);

tenantSubscriptionSchema.index(
  { "stripe.customerId": 1 },
  {
    unique: true,
    sparse: true,
  },
);

tenantSubscriptionSchema.index(
  { "stripe.subscriptionId": 1 },
  {
    unique: true,
    sparse: true,
  },
);

tenantSubscriptionSchema.index({ status: 1, trialEndsAt: 1 });

export const TenantSubscriptionModel =
  (mongoose.models.TenantSubscription as
    TenantSubscriptionMongooseModel | undefined) ??
  mongoose.model<TenantSubscription, TenantSubscriptionMongooseModel>(
    "TenantSubscription",
    tenantSubscriptionSchema,
  );

export default TenantSubscriptionModel;
