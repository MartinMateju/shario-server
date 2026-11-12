import type Stripe from "stripe";
import { getConnectedAccountRequestOptions, getTenantPaymentStripe } from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";

const options = (account: string, key?: string) =>
  getConnectedAccountRequestOptions(account, key ? { idempotencyKey: key } : {});

export const createPlanChangePrice = (account: string, key: string, params: Stripe.PriceCreateParams) =>
  getTenantPaymentStripe().prices.create(params, options(account, key));
export const createPlanChangeSchedule = (account: string, subscription: string, key: string) =>
  getTenantPaymentStripe().subscriptionSchedules.create({ from_subscription: subscription }, options(account, key));
export const retrievePlanChangeSchedule = (account: string, schedule: string) =>
  getTenantPaymentStripe().subscriptionSchedules.retrieve(schedule, {}, options(account));
export const updatePlanChangeSchedule = (account: string, schedule: string, key: string, params: Stripe.SubscriptionScheduleUpdateParams) =>
  getTenantPaymentStripe().subscriptionSchedules.update(schedule, params, options(account, key));
export const releasePlanChangeSchedule = (account: string, schedule: string, key: string) =>
  getTenantPaymentStripe().subscriptionSchedules.release(schedule, { preserve_cancel_date: true }, options(account, key));

/** Once the target period is paid, there are no remaining future instructions.
 * Release (never cancel) so a further change can be scheduled for the next month.
 */
export const releaseAppliedPlanChangeSchedule = async (account: string, subscriptionId: string, change: any) => {
  if (!change?.stripeScheduleId || change.status !== "applied") return;
  const schedule = await retrievePlanChangeSchedule(account, change.stripeScheduleId);
  if (["released", "completed", "canceled"].includes(schedule.status)) return;
  const subscription = typeof schedule.subscription === "string" ? schedule.subscription : schedule.subscription?.id;
  const phase = schedule.phases.find((candidate) => candidate.start_date === schedule.current_phase?.start_date);
  const price = phase?.items[0]?.price;
  const priceId = typeof price === "string" ? price : price?.id;
  if (subscription !== subscriptionId || phase?.items.length !== 1 || priceId !== change.stripePriceId ||
      phase.start_date < Math.floor(new Date(change.effectiveAt).getTime() / 1000)) {
    throw new Error("The paid plan change schedule has unexpected provider state.");
  }
  await releasePlanChangeSchedule(account, schedule.id, `membership-plan-change:${change.key}:release-paid`);
};
