import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  TENANT_BILLING_EMAIL_LOCALE,
  TENANT_BILLING_EMAIL_STATUS,
  TENANT_BILLING_EMAIL_TYPE,
} from "./tenant-subscription.email.constants.js";

export type TenantBillingEmailType =
  (typeof TENANT_BILLING_EMAIL_TYPE)[keyof typeof TENANT_BILLING_EMAIL_TYPE];
export type TenantBillingEmailStatus =
  (typeof TENANT_BILLING_EMAIL_STATUS)[keyof typeof TENANT_BILLING_EMAIL_STATUS];
export type TenantBillingEmailLocale =
  (typeof TENANT_BILLING_EMAIL_LOCALE)[keyof typeof TENANT_BILLING_EMAIL_LOCALE];

export type TenantBillingEmailPayload = {
  recipientName: string;
  tenantName: string;
  billingUrl: string;
  timezone: string;
  trialEndsAt?: string;
  graceEndsAt?: string;
  nextPaymentAttemptAt?: string;
  attemptCount?: number;
};

export type TenantBillingEmailDelivery = {
  _id: Types.ObjectId;
  deliveryKey: string;
  tenant: Types.ObjectId;
  type: TenantBillingEmailType;
  priority: number;
  recipient: string;
  locale: TenantBillingEmailLocale;
  payload: TenantBillingEmailPayload;
  status: TenantBillingEmailStatus;
  attempts: number;
  nextAttemptAt: Date;
  processingStartedAt?: Date;
  sentAt?: Date;
  providerMessageId?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantBillingEmailDeliveryDocument =
  HydratedDocument<TenantBillingEmailDelivery>;
export type TenantBillingEmailDeliveryModel = Model<TenantBillingEmailDelivery>;

export type TenantBillingEmailIntent = {
  type: TenantBillingEmailType;
  deliveryKey: string;
  priority: number;
};
