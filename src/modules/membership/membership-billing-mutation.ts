import { conflict } from "@/shared/http/httpErrors.js";
import UserMembershipModel from "./user-membership.model.js";
import { membershipIdentityHash } from "./membership.idempotency.js";
import { randomUUID } from "node:crypto";
import type mongoose from "mongoose";
import type Stripe from "stripe";

const inProgress = (): never => conflict({
  message: "A membership billing change is already in progress. Refresh and retry the same request.",
  code: "MEMBERSHIP_BILLING_CHANGE_IN_PROGRESS",
});

// An absent legacy version is a precise observation too; do not let Mongoose
// drop an undefined filter and silently turn the claim into an unversioned write.
const observedVersion = (membership: any) => {
  if (membership.__v === undefined) return { $exists: false };
  if (!Number.isSafeInteger(membership.__v) || membership.__v < 0) inProgress();
  return membership.__v;
};

const actionFor = (operation: "cancel" | "resume", input: object): string => {
  if (operation === "resume") return "resume";
  const effective = (input as { effective?: unknown }).effective;
  if (effective !== "period_end" && effective !== "immediate") {
    conflict({ message: "Cancellation must identify its effective timing.", code: "MEMBERSHIP_CANCELLATION_TIMING_REQUIRED" });
  }
  return effective as "period_end" | "immediate";
};

/** A durable claim also fences plan scheduling while a cancellation is in flight.
 * Uncertain provider failures retain ownership, allowing only the identical retry.
 */
export const claimMembershipBillingMutation = async (membership: any, operation: "cancel" | "resume", input: object): Promise<string> => {
  const prefix = `${operation}:${actionFor(operation, input)}:${membershipIdentityHash(input)}:`;
  const prior = membership.billingMutation ?? null;
  if (prior !== null && (typeof prior !== "string" || !prior.startsWith(prefix))) inProgress();
  const key = prior ?? `${prefix}${randomUUID()}`;
  if (membership.scheduledPlanChange) conflict({ message: "Cancel the scheduled plan change before cancelling the membership.", code: "MEMBERSHIP_PLAN_CHANGE_PENDING" });
  const claimed = await UserMembershipModel.findOneAndUpdate({
    _id: membership._id, isOpen: true, scheduledPlanChange: null,
    __v: observedVersion(membership), status: membership.status,
    billingMutation: prior,
  }, { $set: { billingMutation: key }, $inc: { __v: 1 } }, { returnDocument: "after" }).exec();
  if (!claimed) inProgress();
  return key;
};

/** Clear only an observed operation whose requested effect is proven by a fresh
 * authenticated subscription retrieval. Call after saving the local lifecycle
 * state when sharing a transaction, because this advances the document version.
 * Unknown/legacy tokens remain owned rather than guessing their cancellation timing.
 */
export const recoverMembershipBillingMutation = async (
  membership: any,
  subscription: Stripe.Subscription,
  session?: mongoose.ClientSession,
): Promise<boolean> => {
  const key = membership.billingMutation;
  if (typeof key !== "string") return false;
  const operation = /^(cancel:(?:period_end|immediate)|resume:resume):[a-f0-9]{64}:[a-f0-9-]{36}$/.exec(key)?.[1];
  if (!operation) return false;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!membership.stripe?.subscriptionId || subscription.id !== membership.stripe.subscriptionId ||
      !membership.stripe?.customerId || customerId !== membership.stripe.customerId ||
      subscription.metadata?.sharioMembershipId !== String(membership._id) ||
      subscription.metadata?.sharioTenantId !== String(membership.tenant) ||
      subscription.metadata?.sharioUserId !== String(membership.user)) return false;
  const completed = operation === "cancel:immediate"
    ? subscription.status === "canceled"
    : operation === "cancel:period_end"
      ? subscription.cancel_at_period_end === true || subscription.status === "canceled"
      : subscription.status === "active" && subscription.cancel_at_period_end === false && !subscription.cancel_at;
  if (!completed) return false;
  const result = await UserMembershipModel.updateOne({
    _id: membership._id, __v: observedVersion(membership), status: membership.status,
    billingMutation: key, "stripe.subscriptionId": subscription.id, "stripe.customerId": customerId,
  }, { $set: { billingMutation: null }, $inc: { __v: 1 } }, session ? { session } : {}).exec();
  return result.modifiedCount === 1;
};
