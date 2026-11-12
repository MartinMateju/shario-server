import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  TENANT_PAYMENT_DASHBOARD_TYPE,
  TENANT_PAYMENT_ONBOARDING_STATUS,
} from "./tenant-payment-account.constants.js";

export type TenantPaymentOnboardingStatus =
  (typeof TENANT_PAYMENT_ONBOARDING_STATUS)[keyof typeof TENANT_PAYMENT_ONBOARDING_STATUS];

export type TenantPaymentDashboardType =
  (typeof TENANT_PAYMENT_DASHBOARD_TYPE)[keyof typeof TENANT_PAYMENT_DASHBOARD_TYPE];

export type TenantPaymentRequirements = {
  currentlyDue: string[];
  eventuallyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  disabledReason?: string;
};

export type TenantPaymentAccount = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  stripeAccountId?: string;
  accountCreateIdempotencyKey: string;
  provisioningStartedAt?: Date;
  onboardingStatus: TenantPaymentOnboardingStatus;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  country?: string;
  defaultCurrency?: string;
  livemode?: boolean;
  controller: {
    feesPayer: "account";
    lossesPayments: "stripe";
    requirementCollection: "stripe";
    dashboardType: TenantPaymentDashboardType;
  };
  requirements: TenantPaymentRequirements;
  lastStripeEventCreatedAt?: number;
  lastSyncedAt?: Date;
  lastSyncErrorCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantPaymentAccountDocument =
  HydratedDocument<TenantPaymentAccount>;
export type TenantPaymentAccountModel = Model<TenantPaymentAccount>;

export type TenantPaymentAccountSummary = {
  connected: boolean;
  onboardingStatus: TenantPaymentOnboardingStatus;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  country: string | null;
  defaultCurrency: string | null;
  dashboardType: TenantPaymentDashboardType | null;
  lastSyncedAt: Date | null;
};

export type TenantPaymentAccountSnapshot = {
  stripeAccountId: string;
  onboardingStatus: TenantPaymentOnboardingStatus;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  country?: string;
  defaultCurrency?: string;
  livemode: boolean;
  requirements: TenantPaymentRequirements;
  lastSyncedAt: Date;
};

export type ReadyTenantConnectedAccount = {
  tenantId: string;
  stripeAccountId: string;
  country: string | null;
  defaultCurrency: string | null;
};

