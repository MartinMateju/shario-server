import type mongoose from "mongoose";

import { MEMBERSHIP_STATUS } from "../membership.constants.js";
import { expireMembershipEntitlements } from "./membership-entitlement.service.js";
import UserMembershipModel from "../user-membership.model.js";

/**
 * Close a membership and zero every consumable balance in the same transaction.
 * All terminal paths use this primitive so a closed membership can never retain
 * spendable benefits (including the legacy membershipCredits mirror).
 */
export const terminalizeMembership = async (input: {
  tenantId: string;
  membership: any;
  status: typeof MEMBERSHIP_STATUS.CANCELLED | typeof MEMBERSHIP_STATUS.EXPIRED;
  reason: string;
  idempotencyPrefix: string;
  session: mongoose.ClientSession;
  occurredAt?: Date;
  preserveUnknownCancelledAt?: boolean;
}) => {
  await expireMembershipEntitlements({
    tenantId: input.tenantId,
    membership: input.membership,
    reason: input.reason,
    idempotencyPrefix: input.idempotencyPrefix,
    session: input.session,
  });
  if (input.membership.scheduledPlanChange) {
    const change = input.membership.scheduledPlanChange;
    await UserMembershipModel.updateOne({ _id: input.membership._id, "scheduledPlanChange.key": change.key },
      { $push: { planChangeHistory: { ...change.toObject(), status: "cancelled", completedAt: input.occurredAt ?? new Date() } } },
      { session: input.session }).exec();
    input.membership.scheduledPlanChange = null;
  }
  input.membership.billingMutation = null;
  input.membership.status = input.status;
  input.membership.isOpen = false;
  input.membership.autoRenew = false;
  input.membership.cancelAtPeriodEnd = false;
  input.membership.cancelScheduledAt = null;
  if (input.status === MEMBERSHIP_STATUS.CANCELLED) {
    if (!input.preserveUnknownCancelledAt) {
      input.membership.cancelledAt ??= input.occurredAt ?? new Date();
    }
  }
  await input.membership.save({ session: input.session });
};

export default terminalizeMembership;
