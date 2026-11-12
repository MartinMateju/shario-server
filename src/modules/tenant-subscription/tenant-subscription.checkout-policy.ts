import { TENANT_SUBSCRIPTION_STATUS } from "./tenant-subscription.constants.js";
import type { TenantSubscriptionStatus } from "./tenant-subscription.types.js";

export const STRIPE_CHECKOUT_MINIMUM_TRIAL_REMAINING_SECONDS = 48 * 60 * 60;

export type TenantCheckoutTrialPolicy =
  | { kind: "without_trial"; allowed: true; trialEnd: null }
  | { kind: "preserve_trial"; allowed: true; trialEnd: number }
  | { kind: "blocked_final_window"; allowed: false; trialEnd: null };

/**
 * Stripe Checkout only accepts an absolute trial end when it remains at least
 * 48 hours away. Shario must never convert the final trial hours into an early
 * charge, so checkout is blocked only while the final trial hours remain.
 * The hourly lifecycle reconciliation must not delay checkout after expiry.
 */
export const getTenantCheckoutTrialPolicy = ({
  status,
  trialEndsAt,
  now = new Date(),
}: {
  status: TenantSubscriptionStatus;
  trialEndsAt: Date | null | undefined;
  now?: Date;
}): TenantCheckoutTrialPolicy => {
  if (status !== TENANT_SUBSCRIPTION_STATUS.TRIALING) {
    return { kind: "without_trial", allowed: true, trialEnd: null };
  }

  if (!trialEndsAt || !Number.isFinite(trialEndsAt.getTime())) {
    return { kind: "blocked_final_window", allowed: false, trialEnd: null };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const trialEnd = Math.floor(trialEndsAt.getTime() / 1000);

  if (trialEndsAt.getTime() <= now.getTime()) {
    return { kind: "without_trial", allowed: true, trialEnd: null };
  }

  if (
    trialEnd - nowSeconds <=
    STRIPE_CHECKOUT_MINIMUM_TRIAL_REMAINING_SECONDS
  ) {
    return { kind: "blocked_final_window", allowed: false, trialEnd: null };
  }

  return { kind: "preserve_trial", allowed: true, trialEnd };
};
