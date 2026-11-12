import type { ClientSession } from "mongoose";
import type { PlatformBillingCurrency } from "@/shared/money/currency.js";

import TenantSubscriptionModel from "./tenant-subscription.schema.js";
import { TENANT_SUBSCRIPTION_STATUS } from "./tenant-subscription.constants.js";
import type { TenantSubscriptionDocument } from "./tenant-subscription.types.js";

export type SubscriptionRepositoryOptions = {
  session?: ClientSession | null;
};

export const createPendingSubscription = async (
  tenantId: string,
  options: SubscriptionRepositoryOptions & {
    billingCurrency?: PlatformBillingCurrency;
  } = {},
): Promise<TenantSubscriptionDocument> => {
  const [subscription] = await TenantSubscriptionModel.create(
    [
      {
        tenant: tenantId,
        status: TENANT_SUBSCRIPTION_STATUS.PENDING,
        ...(options.billingCurrency
          ? { billingCurrency: options.billingCurrency }
          : {}),
      },
    ],
    options.session ? { session: options.session } : undefined,
  );

  return subscription;
};

export const findSubscriptionByTenant = async (
  tenantId: string,
  options: SubscriptionRepositoryOptions = {},
): Promise<TenantSubscriptionDocument | null> => {
  return TenantSubscriptionModel.findOne({ tenant: tenantId })
    .session(options.session ?? null)
    .exec();
};

export const findSubscriptionByStripeCustomer = async (
  customerId: string,
): Promise<TenantSubscriptionDocument | null> => {
  return TenantSubscriptionModel.findOne({
    "stripe.customerId": customerId,
  }).exec();
};

export const findTenantTrialsEndingBetween = async ({
  startsAfter,
  endsBefore,
  limit = 100,
}: {
  startsAfter: Date;
  endsBefore: Date;
  limit?: number;
}): Promise<TenantSubscriptionDocument[]> =>
  TenantSubscriptionModel.find({
    status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
    "stripe.subscriptionId": { $exists: false },
    trialEndsAt: {
      $gt: startsAfter,
      $lte: endsBefore,
    },
  })
    .sort({ trialEndsAt: 1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .exec();

export const findSubscriptionByStripeSubscription = async (
  subscriptionId: string,
): Promise<TenantSubscriptionDocument | null> => {
  return TenantSubscriptionModel.findOne({
    "stripe.subscriptionId": subscriptionId,
  }).exec();
};

export const expireElapsedTrials = async (now: Date): Promise<number> => {
  const result = await TenantSubscriptionModel.updateMany(
    {
      status: TENANT_SUBSCRIPTION_STATUS.TRIALING,
      trialEndsAt: { $lte: now },
      "stripe.subscriptionId": { $exists: false },
    },
    {
      $set: {
        status: TENANT_SUBSCRIPTION_STATUS.EXPIRED,
        lastSyncedAt: now,
      },
    },
  ).exec();

  return result.modifiedCount;
};
