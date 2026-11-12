import type mongoose from "mongoose";
import type Stripe from "stripe";
import { conflict } from "@/shared/http/httpErrors.js";
import UserMembershipModel from "../user-membership.model.js";
import MembershipEntitlementBalanceModel from "../membership-entitlement-balance.schema.js";
import { calculateTimeCarryover, isTimeAllowance } from "../membership-time-buckets.js";
import { expireMembershipEntitlements } from "./membership-entitlement.service.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";

/** Benefit keys are plan-local. Match unchanged compatible keys, otherwise a
 * unique time allowance with the same unit and purpose. Never guess or convert.
 */
export const planChangeTimeBenefitMapping = (previous: any, next: any): Array<{ from: any; to: any }> => {
  const oldBenefits = previous.benefits ?? [];
  const newBenefits = next.benefits ?? [];
  for (const prior of oldBenefits.filter((benefit: any) => benefit.type === "allowance")) {
    const sameKey = newBenefits.find((benefit: any) => benefit.key === prior.key);
    if (sameKey && (sameKey.type !== prior.type || sameKey.unit !== prior.unit || sameKey.currency !== prior.currency)) {
      conflict({ message: "These plans reuse an allowance key with different units. The studio must update the plan configuration.", code: "MEMBERSHIP_PLAN_CHANGE_BENEFITS_UNSUPPORTED" });
    }
  }
  const targets = newBenefits.filter(isTimeAllowance);
  const used = new Set<string>();
  return oldBenefits.filter(isTimeAllowance).flatMap((from: any) => {
    const compatible = targets.filter((to: any) => to.unit === from.unit && (to.usageScope ?? "") === (from.usageScope ?? ""));
    const exact = compatible.find((to: any) => to.key === from.key);
    const candidates = exact ? [exact] : compatible;
    if (candidates.length > 1 || candidates[0] && used.has(candidates[0].key)) {
      conflict({ message: "The plans have ambiguous time allowances. The studio must update their configuration.", code: "MEMBERSHIP_PLAN_CHANGE_BENEFITS_UNSUPPORTED" });
    }
    if (!candidates.length) {
      if (targets.length) conflict({ message: "The plans use incompatible time allowance units.", code: "MEMBERSHIP_PLAN_CHANGE_BENEFITS_UNSUPPORTED" });
      return [];
    }
    used.add(candidates[0].key);
    return [{ from, to: candidates[0] }];
  });
};

export const applyPaidMembershipPlanChange = async (input: {
  membership: any; invoice: Stripe.Invoice; subscriptionId: string;
  periodStart: Date; periodEnd: Date; session: mongoose.ClientSession;
}): Promise<{ membership: any; carryover?: Record<string, number>; appliedChange?: any }> => {
  const membership = input.membership;
  const change = membership.scheduledPlanChange;
  if (!change || input.periodStart < new Date(change.effectiveAt)) return { membership };
  const invoiceSubscription = typeof input.invoice.subscription === "string" ? input.invoice.subscription : input.invoice.subscription?.id;
  const lines = input.invoice.lines.data.filter((line) => line.type === "subscription" && !line.proration);
  const line = lines[0];
  const price = line?.price;
  if (input.invoice.status !== "paid" || invoiceSubscription !== input.subscriptionId ||
      lines.length !== 1 || !change.stripePriceId || price?.id !== change.stripePriceId ||
      line.quantity !== 1 || price.unit_amount !== change.amountMinor ||
      price.currency.toUpperCase() !== change.currency || input.invoice.currency.toUpperCase() !== change.currency ||
      price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
      line.period.start * 1000 !== input.periodStart.getTime() || line.period.end * 1000 !== input.periodEnd.getTime()) {
    throw new Error("The paid renewal does not match the frozen membership plan change.");
  }
  const carryover: Record<string, number> = {};
  for (const { from, to } of planChangeTimeBenefitMapping(membership.planSnapshot, change.planSnapshot)) {
    const balance = await MembershipEntitlementBalanceModel.findOne({ membership: membership._id, benefitKey: from.key }).session(input.session).exec();
    // Existing carry and manual gifts never carry again. Use the old plan's cap
    // and old grant, before expiring the old balances (including expiry-worker candidates).
    carryover[to.key] = calculateTimeCarryover(balance, from, input.periodStart);
  }
  await expireMembershipEntitlements({ tenantId: String(membership.tenant), membership,
    reason: "plan_changed", idempotencyPrefix: `plan-change:${change.key}:expire`, session: input.session });
  const history = { ...change.toObject(), status: "applied", completedAt: new Date(), invoiceId: input.invoice.id,
    previousPlan: membership.plan, previousPlanVersion: membership.planVersion,
    previousPlanSnapshot: membership.planSnapshot.toObject({ flattenMaps: true }), previousSelectedLocation: membership.selectedLocation,
    previousAmountMinor: membership.amountMinor, previousTermsAcceptedAt: membership.termsAcceptedAt,
    previousTermsAcceptedVersion: membership.termsAcceptedVersion };
  // Purchased snapshots remain immutable to every ordinary update. This one
  // transaction replaces them only with a previously accepted, paid target and
  // archives the complete previous contract alongside its matching invoice.
  const updated = await UserMembershipModel.collection.updateOne({ _id: membership._id,
    isOpen: true, "scheduledPlanChange.key": change.key }, {
    $set: { plan: change.plan, planVersion: change.planVersion, planSnapshot: change.planSnapshot.toObject({ flattenMaps: true }),
      selectedLocation: change.selectedLocation, amountMinor: change.amountMinor,
      termsAcceptedAt: change.termsAcceptedAt, termsAcceptedVersion: change.planSnapshot.version,
      scheduledPlanChange: null, billingMutation: null, updatedAt: new Date() },
    $push: { planChangeHistory: history } as any, $inc: { __v: 1 },
  }, { session: input.session });
  if (updated.modifiedCount !== 1) throw new Error("Membership plan change lost its transactional claim.");
  const current = await UserMembershipModel.findById(membership._id)
    .select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.lastEventCreated +stripe.lastEventId +grantedPeriodKeys")
    .session(input.session).exec();
  await recordMembershipAudit({ tenantId: String(membership.tenant), userId: String(membership.user), membershipId: String(membership._id),
    planId: String(change.plan), type: "membership.plan_changed", source: "webhook",
    metadata: { changeId: change.key, previousPlanId: String(membership.plan), invoiceId: input.invoice.id, effectiveAt: input.periodStart }, session: input.session });
  return { membership: current, carryover, appliedChange: history };
};
