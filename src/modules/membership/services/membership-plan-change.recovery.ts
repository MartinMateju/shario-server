import UserMembershipModel from "../user-membership.model.js";
import { retrieveMembershipSubscription } from "../membership.stripe.gateway.js";
import { createPlanChangeSchedule, releasePlanChangeSchedule, retrievePlanChangeSchedule } from "../membership-plan-change.stripe.js";

const ref = (value: any): string => typeof value === "string" ? value : value?.id ?? "";

/** An outage must not make a legitimate paid OLD-price renewal unusable.
 * Once renewal has advanced, release an unconfigured owned schedule before
 * clearing its local intent. Released schedules fence any late configure retry.
 * A configured target is never unwound or granted without its matching payment.
 */
export const unwindUnconfiguredMembershipPlanChange = async (membership: any): Promise<boolean> => {
  const change = membership.scheduledPlanChange;
  if (change?.status !== "preparing" || Date.now() < new Date(change.effectiveAt).getTime()) return false;
  const account = membership.stripe.connectedAccountId;
  const subscription = await retrieveMembershipSubscription(account, membership.stripe.subscriptionId);
  const oldPrice = change.oldStripePriceId;
  if (!oldPrice || subscription.id !== membership.stripe.subscriptionId ||
      ref(subscription.customer) !== membership.stripe.customerId ||
      subscription.metadata.sharioMembershipId !== String(membership._id) ||
      subscription.metadata.sharioTenantId !== String(membership.tenant) ||
      subscription.metadata.sharioUserId !== String(membership.user) ||
      subscription.current_period_start * 1000 < new Date(change.effectiveAt).getTime() ||
      subscription.items.data.length !== 1 || subscription.items.data[0].price.id !== oldPrice || subscription.items.data[0].quantity !== 1) return false;
  let scheduleId = change.stripeScheduleId;
  if (!scheduleId && subscription.schedule) {
    // Recover a create response lost before DB attachment using its original
    // provider key. An unknown schedule beyond retention remains fail-closed.
    if (Date.now() - new Date(change.requestedAt).getTime() >= 23 * 60 * 60_000) return false;
    const recovered = await createPlanChangeSchedule(account, subscription.id, `membership-plan-change:${change.key}:create`);
    if (recovered.id !== ref(subscription.schedule)) return false;
    scheduleId = recovered.id;
  }
  if (scheduleId) {
    const schedule = await retrievePlanChangeSchedule(account, scheduleId);
    if (ref(schedule.subscription || schedule.released_subscription) !== subscription.id ||
        schedule.phases.some((phase) => phase.items.length !== 1 || ref(phase.items[0].price) !== oldPrice || phase.items[0].quantity !== 1)) return false;
    if (schedule.status === "active" || schedule.status === "not_started") {
      await releasePlanChangeSchedule(account, schedule.id, `membership-plan-change:${change.key}:release-unconfigured`);
    } else if (!["released", "completed"].includes(schedule.status)) return false;
  }
  const after = await retrieveMembershipSubscription(account, subscription.id);
  if (after.schedule || after.items.data.length !== 1 || after.items.data[0].price.id !== oldPrice) return false;
  const history = { ...change.toObject(), stripeScheduleId: scheduleId ?? "", status: "cancelled", completedAt: new Date() };
  const result = await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key,
    "scheduledPlanChange.status": "preparing", billingMutation: `plan-change:${change.key}` },
    { $set: { scheduledPlanChange: null, billingMutation: null }, $push: { planChangeHistory: history }, $inc: { __v: 1 } }).exec();
  return result.modifiedCount === 1;
};
