import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import MembershipWebhookEventModel from "../membership-webhook-event.schema.js";
import MembershipEntitlementBalanceModel from "../membership-entitlement-balance.schema.js";
import UserMembershipModel from "../user-membership.model.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import {
  MEMBERSHIP_RECONCILIATION_BATCH_SIZE,
  MEMBERSHIP_STATUS,
  MEMBERSHIP_WEBHOOK_STATUS,
} from "../membership.constants.js";
import {
  listMembershipSubscriptionInvoices,
  findMembershipCheckoutSession,
  retrieveMembershipCheckoutSession,
  retrieveMembershipSubscription,
} from "../membership.stripe.gateway.js";
import {
  expireDueMembershipEntitlement,
} from "./membership-entitlement.service.js";
import { terminalizeMembership } from "./membership-lifecycle.service.js";
import { syncMembershipInvoice } from "./membership-invoice.service.js";
import {
  membershipStatusFromSubscription,
} from "./membership-webhook.service.js";
import { recoverMembershipCheckout } from "./membership-checkout-recovery.service.js";
import { applyPaymentConfirmed } from "./membership-webhook.service.js";
import { recoverMembershipPlanChange } from "./membership-plan-change.service.js";
import { releaseAppliedPlanChangeSchedule } from "../membership-plan-change.stripe.js";
import { recoverMembershipBillingMutation } from "../membership-billing-mutation.js";

const backfillMembershipSubscriptionInvoices = async (
  membership: any,
  connectedAccountId: string,
  subscriptionId: string,
): Promise<void> => {
  const invoices = await listMembershipSubscriptionInvoices(
    connectedAccountId,
    subscriptionId,
    MEMBERSHIP_RECONCILIATION_BATCH_SIZE,
  );
  const sourceCreated = Math.floor(Date.now() / 1000);
  for (const invoice of invoices.data) {
    try {
      await syncMembershipInvoice({
        membership,
        connectedAccountId,
        invoice,
        source: {
          id: `reconcile:subscription-invoice:${invoice.id}`,
          created: sourceCreated,
        },
      });
    } catch (error) {
      // A malformed historical invoice must not prevent current Subscription
      // lifecycle repair; its deterministic upsert will be retried next run.
      logger.error(
        { err: error, membershipId: membership._id, stripeInvoiceId: invoice.id },
        "Failed to reconcile a membership invoice.",
      );
    }
  }
};

const reconcileExpiredPeriods = async (): Promise<number> => {
  const candidates = await UserMembershipModel.find({
    status: { $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED] },
    currentPeriodEnd: { $lte: new Date() },
    $or: [{ autoRenew: false }, { "planSnapshot.billing.type": "fixed" }],
  }).sort({ currentPeriodEnd: 1 }).limit(MEMBERSHIP_RECONCILIATION_BATCH_SIZE).exec();
  let expired = 0;
  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const membership = await UserMembershipModel.findOne({
          _id: candidate._id,
          status: { $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED] },
          currentPeriodEnd: { $lte: new Date() },
          $or: [{ autoRenew: false }, { "planSnapshot.billing.type": "fixed" }],
        }).session(session).exec();
        if (!membership) return;
        await terminalizeMembership({
          tenantId: String(membership.tenant),
          membership,
          status: MEMBERSHIP_STATUS.EXPIRED,
          reason: "membership_expired",
          idempotencyPrefix: `membership-expired:${membership._id}`,
          session,
        });
        await recordMembershipAudit({
          tenantId: String(membership.tenant),
          userId: String(membership.user),
          membershipId: String(membership._id),
          planId: String(membership.plan),
          type: "membership.expired",
          source: "system",
          session,
        });
        expired += 1;
      });
    } finally {
      await session.endSession();
    }
  }
  return expired;
};

const reconcilePendingCheckouts = async (): Promise<number> => {
  const pending = await UserMembershipModel.find({
    status: MEMBERSHIP_STATUS.PENDING,
    createdAt: { $lte: new Date(Date.now() - 35 * 60_000) },
    "stripe.checkoutSessionId": { $type: "string", $gt: "" },
  })
    .select("+stripe.connectedAccountId +stripe.checkoutSessionId")
    .sort({ createdAt: 1 })
    .limit(MEMBERSHIP_RECONCILIATION_BATCH_SIZE)
    .exec();
  let closed = 0;
  for (const membership of pending) {
    try {
      const checkout = await retrieveMembershipCheckoutSession(
        (membership as any).stripe.connectedAccountId,
        (membership as any).stripe.checkoutSessionId,
      );
      // Authenticated connected-account retrieval is a safe fallback when the
      // signed event is delayed. The shared helper preserves async `processing`
      // and closes only definitive failures.
      const outcome = await recoverMembershipCheckout({
        membership,
        checkout,
        connectedAccountId: (membership as any).stripe.connectedAccountId,
      });
      if (outcome === "closed") closed += 1;
    } catch (error) {
      logger.error({ err: error, membershipId: membership._id }, "Failed to reconcile pending membership checkout.");
    }
  }
  const unattachedFilter = {
      status: MEMBERSHIP_STATUS.PENDING,
      isOpen: true,
      createdAt: { $lte: new Date(Date.now() - 45 * 60_000) },
      $or: [
        { "stripe.checkoutSessionId": "" },
        { "stripe.checkoutSessionId": { $exists: false } },
      ],
  };
  const unattached = await UserMembershipModel.find(unattachedFilter)
    .select("+stripe.connectedAccountId +stripe.checkoutExpiresAt")
    .sort({ createdAt: 1 }).limit(MEMBERSHIP_RECONCILIATION_BATCH_SIZE).exec();
  for (const membership of unattached) {
    try {
      const stripe = (membership as any).stripe;
      if (!stripe?.connectedAccountId) continue;
      // A crash after successful Stripe creation can leave a paid, remote
      // Session with no local attachment. Never infer failure from its age.
      const checkout = await findMembershipCheckoutSession({
        connectedAccountId: stripe.connectedAccountId,
        tenantId: String(membership.tenant),
        membershipId: String(membership._id),
        createdAt: membership.createdAt,
      });
      if (checkout) {
        const attached = await UserMembershipModel.updateOne(
          { ...unattachedFilter, _id: membership._id },
          { $set: { "stripe.checkoutSessionId": checkout.id } },
        ).exec();
        if (attached.modifiedCount !== 1) continue;
        const outcome = await recoverMembershipCheckout({
          membership, checkout, connectedAccountId: stripe.connectedAccountId,
        });
        if (outcome === "closed") closed += 1;
      } else if (Number.isSafeInteger(stripe.checkoutExpiresAt) &&
          stripe.checkoutExpiresAt > 0 && stripe.checkoutExpiresAt <= Math.floor(Date.now() / 1000)) {
        // Only a persisted request deadline plus an authoritative empty remote
        // lookup proves a new request can no longer succeed. Legacy uncertain
        // attempts without a deadline remain pending for safe recovery.
        const result = await UserMembershipModel.updateOne(
          { ...unattachedFilter, _id: membership._id, "stripe.checkoutExpiresAt": stripe.checkoutExpiresAt },
          { $set: { status: MEMBERSHIP_STATUS.EXPIRED, isOpen: false, autoRenew: false } },
        ).exec();
        closed += result.modifiedCount;
      }
    } catch (error) {
      logger.error({ err: error, membershipId: membership._id }, "Failed to recover unattached membership checkout.");
    }
  }
  return closed;
};

const reconcileExpiredBenefits = async (): Promise<number> => {
  const due = await MembershipEntitlementBalanceModel.find({
    available: { $gt: 0 },
    expiresAt: { $lte: new Date() },
  }).sort({ expiresAt: 1 }).limit(MEMBERSHIP_RECONCILIATION_BATCH_SIZE).exec();
  let expired = 0;
  for (const candidate of due) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const membership = await UserMembershipModel.findById(candidate.membership)
          .session(session)
          .exec();
        if (!membership) return;
        const didExpire = await expireDueMembershipEntitlement({
          tenantId: String(membership.tenant),
          membership,
          benefitKey: candidate.benefitKey,
          idempotencyKey: `benefit-expired:${candidate._id}:${candidate.expiresAt?.toISOString()}`,
          session,
        });
        if (didExpire) expired += 1;
      });
    } finally {
      await session.endSession();
    }
  }
  return expired;
};

const reconcileTerminalEntitlements = async (): Promise<number> => {
  const candidates = await MembershipEntitlementBalanceModel.aggregate([
    { $match: { available: { $gt: 0 } } },
    { $group: { _id: "$membership" } },
    { $limit: MEMBERSHIP_RECONCILIATION_BATCH_SIZE },
  ]).exec();
  let cleaned = 0;
  for (const candidate of candidates) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const membership = await UserMembershipModel.findOne({
          _id: candidate._id,
          status: { $in: [MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.EXPIRED] },
        }).session(session).exec();
        if (!membership) return;
        await terminalizeMembership({
          tenantId: String(membership.tenant),
          membership,
          status: membership.status as any,
          reason: "terminal_membership_cleanup",
          idempotencyPrefix: `terminal-membership-cleanup:${membership._id}:${membership.status}`,
          session,
        });
        cleaned += 1;
      });
    } finally {
      await session.endSession();
    }
  }
  return cleaned;
};

const reconcileSubscriptions = async (): Promise<number> => {
  const memberships = await UserMembershipModel.find({
    isOpen: true,
    status: { $in: [
      MEMBERSHIP_STATUS.PENDING,
      MEMBERSHIP_STATUS.ACTIVE,
      MEMBERSHIP_STATUS.PAST_DUE,
      MEMBERSHIP_STATUS.PAUSED,
      MEMBERSHIP_STATUS.CANCEL_SCHEDULED,
    ] },
    "stripe.subscriptionId": { $type: "string", $gt: "" },
  })
    .select("+stripe.connectedAccountId +stripe.subscriptionId +stripe.customerId +planChangeHistory")
    .sort({ "stripe.lastSyncedAt": 1 })
    .limit(MEMBERSHIP_RECONCILIATION_BATCH_SIZE)
    .exec();
  let synced = 0;
  for (const membership of memberships) {
    try {
      try {
        await recoverMembershipPlanChange(membership);
        const history = (membership as any).planChangeHistory ?? [];
        const lastChange = history.at(-1);
        if (!membership.scheduledPlanChange && lastChange?.status === "applied") {
          await releaseAppliedPlanChangeSchedule((membership as any).stripe.connectedAccountId, (membership as any).stripe.subscriptionId, lastChange);
        }
      } catch (error) {
        logger.error({ err: error, membershipId: membership._id }, "Failed to recover a membership plan change.");
      }
      const subscription = await retrieveMembershipSubscription(
        (membership as any).stripe.connectedAccountId,
        (membership as any).stripe.subscriptionId,
      );
      await recoverMembershipBillingMutation(membership, subscription);
      try {
        await backfillMembershipSubscriptionInvoices(
          membership,
          (membership as any).stripe.connectedAccountId,
          subscription.id,
        );
      } catch (error) {
        // Stripe invoice-list availability is independent from Subscription
        // lifecycle repair, so continue with the authenticated Subscription.
        logger.error(
          { err: error, membershipId: membership._id, subscriptionId: subscription.id },
          "Failed to list membership invoices during reconciliation.",
        );
      }
      const status = membershipStatusFromSubscription(subscription);
      if ([MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(status as any)) {
        await applyPaymentConfirmed({
          id: `reconcile:subscription:${subscription.id}:${subscription.current_period_start}`,
          type: "customer.subscription.updated",
          created: Math.floor(Date.now() / 1000),
          data: {
            object: {
              id: subscription.id,
              customer: subscription.customer,
              subscription: subscription.id,
              metadata: subscription.metadata,
            },
          },
        } as any, membership, (membership as any).stripe.connectedAccountId);
        synced += 1;
        continue;
      }
      if (status === MEMBERSHIP_STATUS.CANCELLED) {
        const terminalSession = await mongoose.startSession();
        try {
          await terminalSession.withTransaction(async () => {
            const current = await UserMembershipModel.findById(membership._id)
              .session(terminalSession)
              .exec();
            if (!current) return;
            await terminalizeMembership({
              tenantId: String(current.tenant),
              membership: current,
              status: MEMBERSHIP_STATUS.CANCELLED,
              reason: "reconciled_subscription_cancelled",
              idempotencyPrefix: `reconcile-subscription-cancelled:${subscription.id}`,
              session: terminalSession,
            });
          });
        } finally {
          await terminalSession.endSession();
        }
        synced += 1;
        continue;
      }
      await UserMembershipModel.updateOne(
        { _id: membership._id, isOpen: true },
        { $set: {
          status,
          isOpen: ![MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.EXPIRED].includes(status as any),
          // Only confirmed paid invoices establish entitlement boundaries.
          // Stripe billing periods also advance when collection has failed.
          renewsAt: new Date(subscription.current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          autoRenew: !subscription.cancel_at_period_end && status !== MEMBERSHIP_STATUS.CANCELLED,
          "stripe.lastSyncedAt": new Date(),
        } },
      ).exec();
      synced += 1;
    } catch (error) {
      logger.error({ err: error, membershipId: membership._id }, "Failed to reconcile membership subscription.");
    }
  }
  return synced;
};

export const reconcileMemberships = async () => {
  await MembershipWebhookEventModel.updateMany(
    {
      status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSING,
      leaseExpiresAt: { $lte: new Date() },
    },
    {
      $set: {
        status: MEMBERSHIP_WEBHOOK_STATUS.FAILED,
        claimToken: "",
        leaseExpiresAt: null,
        lastError: "Processing lease expired; awaiting Stripe retry.",
      },
    },
  ).exec();
  // Repair terminal records before time-based benefit expiry to avoid two
  // workers racing over the same positive balance.
  const terminalEntitlementsCleaned = await reconcileTerminalEntitlements();
  const [expired, benefitsExpired, pendingClosed, subscriptionsSynced] = await Promise.all([
    reconcileExpiredPeriods(),
    reconcileExpiredBenefits(),
    reconcilePendingCheckouts(),
    reconcileSubscriptions(),
  ]);
  return { expired, benefitsExpired, pendingClosed, subscriptionsSynced, terminalEntitlementsCleaned };
};
