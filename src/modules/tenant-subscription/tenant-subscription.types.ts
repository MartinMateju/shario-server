import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  TenantPlan,
  TenantStatus,
} from "@/modules/tenants/tenant.types.js";
import type { PlatformBillingCurrency } from "@/shared/money/currency.js";

import type {
  BILLING_INTERVAL,
  PAYMENT_FAILURE_REASON,
  SUBSCRIPTION_ACCESS_MODE,
  TENANT_SUBSCRIPTION_STATUS,
} from "./tenant-subscription.constants.js";

export type TenantSubscriptionStatus =
  (typeof TENANT_SUBSCRIPTION_STATUS)[keyof typeof TENANT_SUBSCRIPTION_STATUS];
export type BillingInterval =
  (typeof BILLING_INTERVAL)[keyof typeof BILLING_INTERVAL];
export type SubscriptionAccessMode =
  (typeof SUBSCRIPTION_ACCESS_MODE)[keyof typeof SUBSCRIPTION_ACCESS_MODE];
export type PaymentFailureReason =
  (typeof PAYMENT_FAILURE_REASON)[keyof typeof PAYMENT_FAILURE_REASON];

export type TenantSubscription = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  status: TenantSubscriptionStatus;
  trialPlan: TenantPlan;
  trialPlanVersion: number;
  billingPlan?: TenantPlan;
  planVersion?: number;
  billingInterval?: BillingInterval;
  billingCurrency?: PlatformBillingCurrency;
  trialStartedAt?: Date;
  trialEndsAt?: Date;
  trialUsedAt?: Date;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  graceEndsAt?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  endedAt?: Date;
  pendingChange?: {
    plan: TenantPlan;
    planVersion: number;
    billingInterval: BillingInterval;
    effectiveAt: Date;
  };
  stripe: {
    customerId?: string;
    subscriptionId?: string;
    subscriptionCreatedAt?: number;
    priceId?: string;
    priceLookupKey?: string;
    offerId?: string;
    scheduleId?: string;
  };
  latestInvoiceId?: string;
  lastPaymentFailedAt?: Date;
  paymentRetryCount?: number;
  nextPaymentAttemptAt?: Date;
  paymentRecoveryUrl?: string;
  paymentFailureReason?: PaymentFailureReason;
  lastPaymentEventCreatedAt?: number;
  lastWebhookEventId?: string;
  lastStripeEventCreatedAt?: number;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantSubscriptionDocument = HydratedDocument<TenantSubscription>;
export type TenantSubscriptionModel = Model<TenantSubscription>;

export type SubscriptionAccess = {
  mode: SubscriptionAccessMode;
  canUseFeatures: boolean;
  reason: string;
  remainingTrialDays: number;
};

export type SubscriptionAccessInput = {
  tenantStatus: TenantStatus;
  subscription: TenantSubscriptionDocument;
  now?: Date;
};
