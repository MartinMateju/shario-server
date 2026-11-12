import { TENANT_STATUS } from "@/modules/tenants/tenant.constants.js";

import {
  SUBSCRIPTION_ACCESS_MODE,
  TENANT_SUBSCRIPTION_STATUS,
} from "./tenant-subscription.constants.js";
import type {
  SubscriptionAccess,
  SubscriptionAccessInput,
} from "./tenant-subscription.types.js";

const millisecondsPerDay = 24 * 60 * 60 * 1000;

const remainingDays = (end: Date | undefined, now: Date): number => {
  if (!end) return 0;

  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / millisecondsPerDay));
};

export const getSubscriptionAccess = ({
  tenantStatus,
  subscription,
  now = new Date(),
}: SubscriptionAccessInput): SubscriptionAccess => {
  if (
    tenantStatus === TENANT_STATUS.SUSPENDED ||
    tenantStatus === TENANT_STATUS.CANCELED
  ) {
    return {
      mode: SUBSCRIPTION_ACCESS_MODE.BLOCKED,
      canUseFeatures: false,
      reason: "tenant_unavailable",
      remainingTrialDays: 0,
    };
  }

  if (subscription.status === TENANT_SUBSCRIPTION_STATUS.PENDING) {
    return {
      mode: SUBSCRIPTION_ACCESS_MODE.SETUP,
      canUseFeatures: false,
      reason: "onboarding",
      remainingTrialDays: 0,
    };
  }

  if (subscription.status === TENANT_SUBSCRIPTION_STATUS.TRIALING) {
    const trialDays = remainingDays(subscription.trialEndsAt, now);

    return {
      mode:
        trialDays > 0
          ? SUBSCRIPTION_ACCESS_MODE.FULL
          : SUBSCRIPTION_ACCESS_MODE.RESTRICTED,
      canUseFeatures: trialDays > 0,
      reason: trialDays > 0 ? "trialing" : "trial_expired",
      remainingTrialDays: trialDays,
    };
  }

  if (subscription.status === TENANT_SUBSCRIPTION_STATUS.ACTIVE) {
    return {
      mode: SUBSCRIPTION_ACCESS_MODE.FULL,
      canUseFeatures: true,
      reason: "active",
      remainingTrialDays: 0,
    };
  }

  if (subscription.status === TENANT_SUBSCRIPTION_STATUS.PAST_DUE) {
    const inGrace = Boolean(
      subscription.graceEndsAt && subscription.graceEndsAt.getTime() > now.getTime(),
    );

    return {
      mode: inGrace
        ? SUBSCRIPTION_ACCESS_MODE.GRACE
        : SUBSCRIPTION_ACCESS_MODE.RESTRICTED,
      canUseFeatures: inGrace,
      reason: inGrace ? "payment_grace" : "payment_overdue",
      remainingTrialDays: 0,
    };
  }

  return {
    mode: SUBSCRIPTION_ACCESS_MODE.RESTRICTED,
    canUseFeatures: false,
    reason: subscription.status,
    remainingTrialDays: 0,
  };
};
