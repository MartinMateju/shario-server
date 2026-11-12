import {
  BILLING_INTERVAL,
  TENANT_SUBSCRIPTION_STATUS,
  TENANT_TRIAL_DAYS,
} from "@/modules/tenant-subscription/tenant-subscription.constants.js";

const DAY_MS = 86_400_000;

/** Monthly allowances must not inherit a manual multi-year access grant. */
export const resolveMonthlyUsageWindow = (
  subscription: {
    status?: string;
    billingInterval?: string;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    trialStartedAt?: Date | null;
    trialEndsAt?: Date | null;
  },
  now: Date,
): { start: Date; end: Date } => {
  const validWindow = (
    start: Date | null | undefined,
    end: Date | null | undefined,
    maxDays: number,
  ) =>
    start instanceof Date &&
    end instanceof Date &&
    start.getTime() <= now.getTime() &&
    end.getTime() > now.getTime() &&
    end.getTime() - start.getTime() <= maxDays * DAY_MS;

  if (
    subscription.status === TENANT_SUBSCRIPTION_STATUS.TRIALING &&
    validWindow(
      subscription.trialStartedAt,
      subscription.trialEndsAt,
      TENANT_TRIAL_DAYS,
    )
  ) {
    return {
      start: subscription.trialStartedAt!,
      end: subscription.trialEndsAt!,
    };
  }
  // One monthly billing period may span 31 days and a daylight-saving change.
  if (
    subscription.billingInterval !== BILLING_INTERVAL.YEARLY &&
    validWindow(
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd,
      32,
    )
  ) {
    return {
      start: subscription.currentPeriodStart!,
      end: subscription.currentPeriodEnd!,
    };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
};
