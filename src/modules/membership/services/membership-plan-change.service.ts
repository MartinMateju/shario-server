import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { z } from "zod";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import UserMembershipModel from "../user-membership.model.js";
import MembershipPlanModel from "../membership-plan.model.js";
import MembershipPlanVersionModel from "../membership-plan-version.model.js";
import { membershipIdentityHash, assertMembershipIdempotencyIdentity } from "../membership.idempotency.js";
import { toObjectId } from "../membership.utils.js";
import { membershipPlanSnapshot, userMembershipService } from "./user-membership.service.js";
import { retrieveMembershipSubscription } from "../membership.stripe.gateway.js";
import { createPlanChangePrice, createPlanChangeSchedule, retrievePlanChangeSchedule, updatePlanChangeSchedule, releasePlanChangeSchedule } from "../membership-plan-change.stripe.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import { membershipLocalizedText } from "../membership.localization.js";
import type { membershipPlanChangeSchema } from "../membership.validators.js";
import { planChangeTimeBenefitMapping } from "./membership-plan-change.payment.js";
import { unwindUnconfiguredMembershipPlanChange } from "./membership-plan-change.recovery.js";

const stripeFields = "+stripe.connectedAccountId +stripe.subscriptionId +stripe.customerId +planChangeHistory";
const ref = (value: any): string => typeof value === "string" ? value : value?.id ?? "";
const monthly = (billing: any) => billing?.type === "recurring" && billing.interval === "month" && Number(billing.intervalCount) === 1;
const fail = (message: string, code = "MEMBERSHIP_PLAN_CHANGE_UNAVAILABLE"): never => conflict({ message, code });
const seconds = (date: Date) => Math.floor(new Date(date).getTime() / 1000);

const ownedMembership = async (tenantId: string, userId: string) => {
  const membership = await UserMembershipModel.findOne({ tenant: toObjectId(tenantId), user: toObjectId(userId), isOpen: true }).select(stripeFields).exec();
  if (!membership) notFound("Open membership not found.");
  return membership as any;
};

export const assertPlanChangeSubscription = (membership: any, subscription: Stripe.Subscription, allowOwnSchedule = false) => {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  if (subscription.id !== membership.stripe.subscriptionId ||
      ref(subscription.customer) !== membership.stripe.customerId ||
      subscription.metadata.sharioMembershipId !== String(membership._id) ||
      subscription.metadata.sharioTenantId !== String(membership.tenant) ||
      subscription.metadata.sharioUserId !== String(membership.user)) {
    fail("The subscription does not match this membership.");
  }
  if (subscription.status !== "active" || subscription.cancel_at_period_end || subscription.cancel_at ||
      subscription.pause_collection || subscription.pending_update ||
      subscription.current_period_start !== seconds(membership.currentPeriodStart) ||
      subscription.current_period_end !== seconds(membership.currentPeriodEnd) ||
      subscription.current_period_end <= Math.floor(Date.now() / 1000)) {
    fail("Only a current paid monthly membership can change plans at its next renewal.");
  }
  if ((!allowOwnSchedule && subscription.schedule) || subscription.items.data.length !== 1 ||
      item.quantity !== 1 || price?.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== "licensed" || price.currency.toUpperCase() !== membership.currency ||
      price.unit_amount !== membership.amountMinor || subscription.collection_method !== "charge_automatically" ||
      subscription.discount || subscription.default_tax_rates?.length || subscription.automatic_tax?.enabled ||
      subscription.billing_thresholds || subscription.transfer_data || subscription.application_fee_percent ||
      item.tax_rates?.length || item.billing_thresholds || subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000)) {
    fail("This subscription's billing settings require the studio to change its plan.");
  }
};

const finishScheduling = async (membership: any) => {
  if (await unwindUnconfiguredMembershipPlanChange(membership)) {
    fail("The change could not be scheduled before renewal. Your existing plan renewed; please choose a new change.", "MEMBERSHIP_PLAN_CHANGE_NOT_SCHEDULED");
  }
  const change = membership.scheduledPlanChange;
  const account = membership.stripe.connectedAccountId;
  const prefix = `membership-plan-change:${change.key}`;
  let subscription = await retrieveMembershipSubscription(account, membership.stripe.subscriptionId);
  let schedule: Stripe.SubscriptionSchedule | undefined;
  if (change.stripeScheduleId) {
    schedule = await retrievePlanChangeSchedule(account, change.stripeScheduleId);
    if (ref(schedule.subscription) !== subscription.id && ref(schedule.released_subscription) !== subscription.id) fail("The plan-change schedule no longer belongs to this membership.");
  }
  const configured = (candidate: Stripe.SubscriptionSchedule | undefined) => candidate?.phases.some((phase) =>
    phase.start_date === seconds(change.effectiveAt) && phase.items.length === 1 &&
    ref(phase.items[0].price) === change.stripePriceId && phase.items[0].quantity === 1);
  if (!configured(schedule)) {
    assertPlanChangeSubscription(membership, subscription, true);
    if (subscription.schedule && change.stripeScheduleId && ref(subscription.schedule) !== change.stripeScheduleId) fail("Another schedule manages this subscription.");
    if (!change.stripePriceId) {
      const price = await createPlanChangePrice(account, `${prefix}:price`, {
        currency: change.currency.toLowerCase(), unit_amount: change.amountMinor,
        recurring: { interval: "month", interval_count: 1 },
        product_data: { name: membershipLocalizedText(change.planSnapshot, "name", change.locale),
          metadata: { sharioMembershipId: String(membership._id), sharioPlanChangeId: change.key } },
        metadata: { sharioMembershipId: String(membership._id), sharioPlanChangeId: change.key },
      });
      await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key, "scheduledPlanChange.status": "preparing" },
        { $set: { "scheduledPlanChange.stripePriceId": price.id, "scheduledPlanChange.oldStripePriceId": subscription.items.data[0].price.id } }).exec();
      change.stripePriceId = price.id;
      change.oldStripePriceId = subscription.items.data[0].price.id;
    }
    if (!schedule) {
      // Replaying the same provider key recovers a successful create whose DB attach failed.
      // Do not reuse that key after Stripe may have pruned its 24-hour record.
      if (Date.now() - new Date(change.requestedAt).getTime() >= 23 * 60 * 60_000) fail("The interrupted plan change needs billing reconciliation.", "MEMBERSHIP_PLAN_CHANGE_RECOVERY_REQUIRED");
      schedule = await createPlanChangeSchedule(account, subscription.id, `${prefix}:create`);
      await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key, "scheduledPlanChange.status": "preparing" },
        { $set: { "scheduledPlanChange.stripeScheduleId": schedule.id } }).exec();
      change.stripeScheduleId = schedule.id;
    }
    subscription = await retrieveMembershipSubscription(account, membership.stripe.subscriptionId);
    assertPlanChangeSubscription(membership, subscription, true);
    if (ref(subscription.schedule) !== schedule.id || schedule.status !== "active" ||
        schedule.phases.length !== 1 || ref(schedule.phases[0].items[0]?.price) !== change.oldStripePriceId) {
      fail("The subscription schedule was changed outside this request.", "MEMBERSHIP_PLAN_CHANGE_RECOVERY_REQUIRED");
    }
    const existing: any = schedule.phases[0];
    const phaseSettings: Record<string, any> = {};
    for (const name of ["collection_method", "currency", "description", "invoice_settings", "billing_cycle_anchor", "metadata"]) {
      if (existing[name] != null) phaseSettings[name] = existing[name];
    }
    if (existing.default_payment_method) phaseSettings.default_payment_method = ref(existing.default_payment_method);
    const metadata = { ...subscription.metadata, sharioPlanId: String(change.plan), sharioPlanVersionId: String(change.planVersion), sharioPlanChangeId: change.key };
    schedule = await updatePlanChangeSchedule(account, schedule.id, `${prefix}:configure`, {
      end_behavior: "release", proration_behavior: "none",
      metadata: { sharioMembershipId: String(membership._id), sharioPlanChangeId: change.key },
      phases: [
        { ...phaseSettings, start_date: existing.start_date, end_date: seconds(change.effectiveAt),
          items: [{ price: change.oldStripePriceId, quantity: 1 }], proration_behavior: "none" },
        { ...phaseSettings, start_date: seconds(change.effectiveAt), iterations: 1,
          items: [{ price: change.stripePriceId, quantity: 1 }], metadata, proration_behavior: "none" },
      ],
    });
    if (!configured(schedule)) fail("Stripe has not confirmed the scheduled plan change.", "MEMBERSHIP_PLAN_CHANGE_RECOVERY_REQUIRED");
  }
  const updated = await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key, "scheduledPlanChange.status": "preparing" },
    { $set: { "scheduledPlanChange.status": "scheduled", billingMutation: null }, $inc: { __v: 1 } }).exec();
  if (updated.modifiedCount) await recordMembershipAudit({ tenantId: String(membership.tenant), userId: String(membership.user),
    membershipId: String(membership._id), planId: String(change.plan), type: "membership.plan_change_scheduled", source: "customer",
    metadata: { changeId: change.key, effectiveAt: change.effectiveAt, fromPlanId: String(membership.plan) } });
};

const finishCancellation = async (membership: any) => {
  const change = membership.scheduledPlanChange;
  const account = membership.stripe.connectedAccountId;
  const schedule = await retrievePlanChangeSchedule(account, change.stripeScheduleId);
  const subscription = await retrieveMembershipSubscription(account, membership.stripe.subscriptionId);
  if (ref(schedule.subscription || schedule.released_subscription) !== subscription.id) fail("The schedule does not belong to this membership.");
  if (schedule.metadata?.sharioMembershipId !== String(membership._id) || schedule.metadata?.sharioPlanChangeId !== change.key) {
    fail("The plan-change schedule was modified outside this request.", "MEMBERSHIP_PLAN_CHANGE_RECOVERY_REQUIRED");
  }
  if (subscription.items.data.some((item) => item.price.id === change.stripePriceId) ||
      schedule.current_phase && schedule.current_phase.start_date >= seconds(change.effectiveAt)) {
    await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key },
      { $set: { "scheduledPlanChange.status": "scheduled", billingMutation: null } }).exec();
    fail("The renewal has started; this plan change can no longer be cancelled.", "MEMBERSHIP_PLAN_CHANGE_TOO_LATE");
  }
  if (schedule.status !== "released") {
    if (Date.now() >= new Date(change.effectiveAt).getTime()) {
      await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key },
        { $set: { "scheduledPlanChange.status": "scheduled", billingMutation: null } }).exec();
      fail("The renewal is being processed. Retry after its payment is confirmed.", "MEMBERSHIP_PLAN_CHANGE_TOO_LATE");
    }
    await releasePlanChangeSchedule(account, schedule.id, `membership-plan-change:${change.key}:release`);
  }
  // A phase transition could win the release race. Never report a cancelled change
  // while its price is already active; the paid invoice still owns local activation.
  const after = await retrieveMembershipSubscription(account, subscription.id);
  if (after.items.data.length !== 1 || after.items.data[0].price.id !== change.oldStripePriceId || after.schedule) {
    await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key },
      { $set: { "scheduledPlanChange.status": "scheduled", billingMutation: null } }).exec();
    fail("The renewal has started; this plan change can no longer be cancelled.", "MEMBERSHIP_PLAN_CHANGE_TOO_LATE");
  }
  const historical = { ...change.toObject(), status: "cancelled", completedAt: new Date() };
  await UserMembershipModel.updateOne({ _id: membership._id, "scheduledPlanChange.key": change.key, "scheduledPlanChange.status": "cancelling" },
    { $set: { scheduledPlanChange: null, billingMutation: null }, $push: { planChangeHistory: historical }, $inc: { __v: 1 } }).exec();
};

export const recoverMembershipPlanChange = async (membership: any) => {
  if (await unwindUnconfiguredMembershipPlanChange(membership)) return;
  if (membership.scheduledPlanChange?.status === "preparing") await finishScheduling(membership);
  if (membership.scheduledPlanChange?.status === "cancelling") await finishCancellation(membership);
};

export const membershipPlanChangeService = {
  async schedule(tenantId: string, userId: string, input: z.infer<typeof membershipPlanChangeSchema>, requestKey?: string) {
    if (!requestKey?.trim() || requestKey.trim().length < 8 || requestKey.trim().length > 160) fail("A valid Idempotency-Key is required.", "MEMBERSHIP_IDEMPOTENCY_KEY_REQUIRED");
    const key = requestKey.trim();
    const requestHash = membershipIdentityHash({ tenantId, userId, ...input });
    let membership = await ownedMembership(tenantId, userId);
    const previous = (membership.planChangeHistory ?? []).find((change: any) => change.requestKey === key);
    if (previous) {
      assertMembershipIdempotencyIdentity(previous.requestHash, requestHash);
      return { membership: await userMembershipService.mine(tenantId, userId) };
    }
    if (membership.scheduledPlanChange) {
      if (membership.scheduledPlanChange.requestKey !== key) fail("Cancel the existing scheduled change before choosing another plan.", "MEMBERSHIP_PLAN_CHANGE_PENDING");
      assertMembershipIdempotencyIdentity(membership.scheduledPlanChange.requestHash, requestHash);
      if (membership.scheduledPlanChange.status === "preparing") await finishScheduling(membership);
      else if (membership.scheduledPlanChange.status !== "scheduled") fail("The plan change is being cancelled.", "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS");
      return { membership: await userMembershipService.mine(tenantId, userId) };
    }
    if (membership.status !== "active" || !membership.autoRenew || membership.cancelAtPeriodEnd || membership.billingMutation ||
        !monthly(membership.planSnapshot.billing) || !membership.stripe?.connectedAccountId || !membership.stripe?.subscriptionId ||
        !membership.currentPeriodStart || !membership.currentPeriodEnd || new Date(membership.currentPeriodEnd) <= new Date()) {
      fail("Only a current paid monthly membership can change plans at its next renewal.");
    }
    const plan = await MembershipPlanModel.findOne({ _id: toObjectId(input.planId), tenant: toObjectId(tenantId), status: "published" }).exec();
    if (!plan || String(plan.currentPublishedVersion) !== input.planVersionId) fail("The selected membership version is no longer available.", "MEMBERSHIP_VERSION_STALE");
    const version = await MembershipPlanVersionModel.findOne({ _id: toObjectId(input.planVersionId), plan: plan._id, tenant: toObjectId(tenantId), status: "published" }).exec();
    if (!version) notFound("Published membership plan version not found.");
    if (!monthly(version.billing)) fail("Plan changes are available between monthly memberships only.");
    if (String(membership.planVersion) === input.planVersionId) fail("This is already your current membership plan.", "MEMBERSHIP_PLAN_CHANGE_SAME_PLAN");
    const price = version.prices.find((candidate) => candidate.currency === membership.currency);
    if (!price || !Number.isSafeInteger(price.amountMinor) || price.amountMinor <= 0) fail("The new plan must be offered in the current membership currency.", "MEMBERSHIP_CURRENCY_NOT_OFFERED");
    let selectedLocation = null;
    if (version.locationScope.type === "selected") {
      if (!input.locationId || !version.locationScope.locationIds.map(String).includes(input.locationId)) fail("Select a location offered by this membership plan.", "MEMBERSHIP_LOCATION_REQUIRED");
      selectedLocation = toObjectId(input.locationId);
    } else if (input.locationId) fail("A location cannot be selected for this membership.", "MEMBERSHIP_LOCATION_NOT_APPLICABLE");
    const snapshot = membershipPlanSnapshot(version);
    planChangeTimeBenefitMapping(membership.planSnapshot, snapshot);
    const subscription = await retrieveMembershipSubscription(membership.stripe.connectedAccountId, membership.stripe.subscriptionId);
    assertPlanChangeSubscription(membership, subscription);
    const change = { key: randomUUID(), requestKey: key, requestHash, status: "preparing", plan: plan._id, planVersion: version._id,
      planSnapshot: snapshot, selectedLocation, currency: membership.currency, amountMinor: price.amountMinor,
      periodStart: membership.currentPeriodStart, effectiveAt: membership.currentPeriodEnd, requestedAt: new Date(), termsAcceptedAt: new Date(), locale: input.locale,
      oldStripePriceId: subscription.items.data[0].price.id };
    membership = await UserMembershipModel.findOneAndUpdate({ _id: membership._id, __v: membership.__v, status: "active", isOpen: true,
      autoRenew: true, cancelAtPeriodEnd: false, scheduledPlanChange: null, billingMutation: null, currentPeriodEnd: change.effectiveAt },
      { $set: { scheduledPlanChange: change, billingMutation: `plan-change:${change.key}` }, $inc: { __v: 1 } },
      { returnDocument: "after", runValidators: true }).select(stripeFields).exec();
    if (!membership) fail("Another membership change won the race. Refresh and retry.", "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS");
    await finishScheduling(membership);
    return { membership: await userMembershipService.mine(tenantId, userId) };
  },
  async cancel(tenantId: string, userId: string) {
    let membership = await ownedMembership(tenantId, userId);
    const change = membership.scheduledPlanChange;
    if (!change) return { membership: await userMembershipService.mine(tenantId, userId) };
    if (change.status === "preparing") fail("Scheduling is still being confirmed. Retry shortly.", "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS");
    if (change.status === "scheduled") {
      if (new Date(change.effectiveAt) <= new Date()) fail("The renewal has started; this change can no longer be cancelled.", "MEMBERSHIP_PLAN_CHANGE_TOO_LATE");
      membership = await UserMembershipModel.findOneAndUpdate({ _id: membership._id, "scheduledPlanChange.key": change.key,
        "scheduledPlanChange.status": "scheduled", billingMutation: null },
        { $set: { "scheduledPlanChange.status": "cancelling", billingMutation: `plan-change-cancel:${change.key}` }, $inc: { __v: 1 } },
        { returnDocument: "after" }).select(stripeFields).exec();
      if (!membership) fail("Another membership change is in progress. Retry shortly.", "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS");
    }
    await finishCancellation(membership);
    return { membership: await userMembershipService.mine(tenantId, userId) };
  },
};
