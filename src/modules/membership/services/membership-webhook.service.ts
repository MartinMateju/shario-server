import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import type Stripe from "stripe";

import { findTenantPaymentAccountByStripeAccount } from "@/modules/tenant-payments/tenant-payment-account.repository.js";
import { logger } from "@/config/logger.js";
import MembershipWebhookEventModel from "../membership-webhook-event.schema.js";
import UserMembershipModel from "../user-membership.model.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import {
  MEMBERSHIP_STATUS,
  MEMBERSHIP_WEBHOOK_LEASE_MS,
  MEMBERSHIP_WEBHOOK_STATUS,
} from "../membership.constants.js";
import {
  assertMembershipIdempotencyIdentity,
  membershipIdentityHash,
} from "../membership.idempotency.js";
import {
  MEMBERSHIP_STRIPE_FLOW,
  retrieveMembershipCheckoutSession,
  retrieveMembershipSubscription,
} from "../membership.stripe.gateway.js";
import {
  grantMembershipPeriodEntitlements,
} from "./membership-entitlement.service.js";
import { terminalizeMembership } from "./membership-lifecycle.service.js";
import { syncMembershipInvoice } from "./membership-invoice.service.js";
import { recoverMembershipCheckout } from "./membership-checkout-recovery.service.js";
import { enqueueMembershipNotification } from "./membership-notification.service.js";
import { toObjectId } from "../membership.utils.js";
import { applyPaidMembershipPlanChange } from "./membership-plan-change.payment.js";
import { releaseAppliedPlanChangeSchedule } from "../membership-plan-change.stripe.js";
import { unwindUnconfiguredMembershipPlanChange } from "./membership-plan-change.recovery.js";
import { recoverMembershipBillingMutation } from "../membership-billing-mutation.js";

const supportedTypes = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
]);

const eventObjectId = (event: Stripe.Event): string => {
  const object: any = event.data.object;
  return typeof object?.id === "string" ? object.id : "";
};

const metadataFor = (object: any): Record<string, string> =>
  object?.metadata && typeof object.metadata === "object" ? object.metadata : {};

const connectedAccountId = (event: Stripe.Event): string | null =>
  typeof event.account === "string" && event.account.startsWith("acct_")
    ? event.account
    : null;

const eventMutationSource = (eventId: string): "webhook" | "system" =>
  eventId.startsWith("reconcile:") || eventId.startsWith("recover:")
    ? "system"
    : "webhook";

export const isMembershipStripeEvent = (event: Stripe.Event): boolean => {
  if (!supportedTypes.has(event.type)) return false;
  const object: any = event.data.object;
  if (event.type.startsWith("invoice.")) return true;
  return metadataFor(object).sharioFlow === MEMBERSHIP_STRIPE_FLOW;
};

const findMembershipForEvent = async (event: Stripe.Event, accountId: string, tenantId: string) => {
  const object: any = event.data.object;
  const metadata = metadataFor(object);
  let query: Record<string, unknown> | null = null;
  if (metadata.sharioMembershipId) {
    query = { _id: toObjectId(metadata.sharioMembershipId) };
  } else if (event.type.startsWith("invoice.") && typeof object.subscription === "string") {
    query = { "stripe.subscriptionId": object.subscription };
  }
  if (!query) return null;
  let membership = await UserMembershipModel.findOne({
    ...query,
    tenant: toObjectId(tenantId),
    "stripe.connectedAccountId": accountId,
  }).select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.lastEventCreated +stripe.lastEventId +grantedPeriodKeys").exec();
  // Invoice delivery may beat checkout.session.completed/subscription.created.
  // Resolve ownership from the current connected-account Subscription metadata,
  // then still validate the resulting membership against the account's tenant.
  if (!membership && event.type.startsWith("invoice.") && typeof object.subscription === "string") {
    const subscription = await retrieveMembershipSubscription(accountId, object.subscription);
    const subscriptionMembershipId = metadataFor(subscription).sharioMembershipId;
    if (subscriptionMembershipId) {
      membership = await UserMembershipModel.findOne({
        _id: toObjectId(subscriptionMembershipId),
        tenant: toObjectId(tenantId),
        "stripe.connectedAccountId": accountId,
      }).select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.lastEventCreated +stripe.lastEventId +grantedPeriodKeys").exec();
    }
  }
  return membership;
};

const assertEventOwnership = (event: Stripe.Event, membership: any, tenantId: string) => {
  const metadata = metadataFor(event.data.object as any);
  if (metadata.sharioTenantId && metadata.sharioTenantId !== tenantId) {
    throw new Error("Stripe membership tenant metadata does not match its connected account.");
  }
  if (metadata.sharioMembershipId && metadata.sharioMembershipId !== String(membership._id)) {
    throw new Error("Stripe membership metadata does not match the stored membership.");
  }
  if (metadata.sharioUserId && metadata.sharioUserId !== String(membership.user)) {
    throw new Error("Stripe membership user metadata does not match the stored membership.");
  }
};

const claimEvent = async (event: Stripe.Event, accountId: string) => {
  const identityHash = membershipIdentityHash({
    eventId: event.id,
    eventType: event.type,
    eventCreated: event.created,
    connectedAccountId: accountId,
    objectId: eventObjectId(event),
  });
  let record = await MembershipWebhookEventModel.findOne({ eventId: event.id }).exec();
  if (!record) {
    try {
      record = await MembershipWebhookEventModel.create({
        eventId: event.id,
        eventType: event.type,
        eventCreated: event.created,
        connectedAccountId: accountId,
        objectId: eventObjectId(event),
        identityHash,
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      record = await MembershipWebhookEventModel.findOne({ eventId: event.id }).exec();
    }
  }
  if (!record) throw new Error("Membership webhook event record could not be created.");
  assertMembershipIdempotencyIdentity(record.identityHash, identityHash);
  if (record.status === MEMBERSHIP_WEBHOOK_STATUS.PROCESSED) return null;
  const now = new Date();
  const token = randomUUID();
  const claimed = await MembershipWebhookEventModel.findOneAndUpdate(
    {
      _id: record._id,
      $or: [
        { status: MEMBERSHIP_WEBHOOK_STATUS.PENDING },
        { status: MEMBERSHIP_WEBHOOK_STATUS.FAILED },
        {
          status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSING,
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSING,
        claimToken: token,
        leaseExpiresAt: new Date(now.getTime() + MEMBERSHIP_WEBHOOK_LEASE_MS),
        lastError: "",
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  ).exec();
  return claimed ? { record: claimed, token } : null;
};

const markProcessed = (recordId: unknown, token: string) =>
  MembershipWebhookEventModel.updateOne(
    { _id: recordId, status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSING, claimToken: token },
    { $set: { status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSED, processedAt: new Date(), claimToken: "", leaseExpiresAt: null } },
  ).exec();

const markFailed = (recordId: unknown, token: string, error: unknown) =>
  MembershipWebhookEventModel.updateOne(
    { _id: recordId, status: MEMBERSHIP_WEBHOOK_STATUS.PROCESSING, claimToken: token },
    { $set: {
      status: MEMBERSHIP_WEBHOOK_STATUS.FAILED,
      claimToken: "",
      leaseExpiresAt: null,
      lastError: String(error instanceof Error ? error.message : error).slice(0, 2000),
    } },
  ).exec();

const statusWithoutUnpaidActivation = (membership: any, status: string) => {
  if (
    ![MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(
      status as any,
    )
  ) {
    return status;
  }
  // Subscription status (including trialing) is not proof of payment. The
  // paid-period fields are written only by payment confirmation/manual grants.
  const start = membership.currentPeriodStart?.getTime();
  const end = membership.currentPeriodEnd?.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? status
    : MEMBERSHIP_STATUS.PENDING;
};

/** A late paid invoice may only fund its own period, never today's subscription period. */
export const periodFromPaidMembershipInvoice = (invoice: Stripe.Invoice, subscriptionId: string) => {
  const invoiceSubscription = typeof invoice.subscription === "string"
    ? invoice.subscription : invoice.subscription?.id;
  if (invoice.status !== "paid" || invoiceSubscription !== subscriptionId) {
    throw new Error("Membership period requires a paid invoice for the same subscription.");
  }
  const recurringLines = (invoice.lines?.data ?? []).filter((line) =>
    line.type === "subscription" && !line.proration &&
    (!line.subscription || line.subscription === subscriptionId));
  const line = recurringLines.find((item) => item.period?.end > item.period?.start);
  if (!line || recurringLines.some((item) =>
    item.period.start !== line.period.start || item.period.end !== line.period.end)) {
    throw new Error("Membership invoice must identify one unambiguous paid subscription period.");
  }
  return { start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000),
    key: `subscription:${subscriptionId}:period:${line.period.start}` };
};

export const fixedPeriodFromPaymentConfirmation = (input: {
  membership: any;
  eventCreated: number;
  invoicePaidAt?: number | null;
}) => {
  const establishedStart = input.membership.startedAt ?? input.membership.currentPeriodStart;
  const start = establishedStart ?? new Date((input.invoicePaidAt ?? input.eventCreated) * 1000);
  const end = establishedStart && input.membership.currentPeriodEnd
    ? input.membership.currentPeriodEnd
    : new Date(
        start.getTime() +
        Number((input.membership.planSnapshot.billing as any).durationDays ?? 1) * 86_400_000,
      );
  return { start, end, key: `fixed:${input.membership._id}` };
};

export const membershipStatusFromSubscription = (subscription: Stripe.Subscription): string => {
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
    return MEMBERSHIP_STATUS.CANCELLED;
  }
  if (subscription.status === "past_due" || subscription.status === "unpaid") {
    return MEMBERSHIP_STATUS.PAST_DUE;
  }
  if (subscription.status === "paused") return MEMBERSHIP_STATUS.PAUSED;
  if (subscription.cancel_at_period_end) return MEMBERSHIP_STATUS.CANCEL_SCHEDULED;
  if (subscription.status === "active" || subscription.status === "trialing") return MEMBERSHIP_STATUS.ACTIVE;
  return MEMBERSHIP_STATUS.PENDING;
};

export const applyPaymentConfirmed = async (
  event: Stripe.Event,
  membership: any,
  accountId: string,
  invoice?: Stripe.Invoice,
) => {
  let appliedChange: any;
  await unwindUnconfiguredMembershipPlanChange(membership);
  // Checkout confirmation can arrive after a renewal. Retrieve the original
  // checkout invoice instead of granting the subscription's latest period.
  if (!invoice && event.type.startsWith("checkout.session.")) {
    const checkout = event.data.object as Stripe.Checkout.Session;
    if (checkout.subscription) {
      const invoiceId = typeof checkout.invoice === "string" ? checkout.invoice : checkout.invoice?.id;
      if (!invoiceId) throw new Error("Paid membership checkout is missing its invoice.");
      invoice = await syncMembershipInvoice({ membership, connectedAccountId: accountId,
        invoice: invoiceId, source: { id: event.id, created: event.created } });
    }
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      let current = await UserMembershipModel.findById(membership._id)
        .select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.lastEventCreated +stripe.lastEventId +grantedPeriodKeys")
        .session(session)
        .exec();
      if (!current) return;
      if ([MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.EXPIRED].includes(current.status as any)) {
        // Repair any legacy/inconsistent terminal record that retained a
        // spendable balance, but never reactivate it from a late paid event.
        await terminalizeMembership({
          tenantId: String(current.tenant),
          membership: current,
          status: current.status as any,
          reason: "terminal_membership_cleanup",
          idempotencyPrefix: `terminal-membership-cleanup:${current._id}:${current.status}`,
          session,
        });
        return;
      }
      if (!current.isOpen) return;
      // A first payment can follow an initial past-due invoice. It still
      // activates the membership rather than announcing a monthly renewal.
      const wasPending = !current.startedAt && !current.currentPeriodStart;
      const object: any = event.data.object;
      const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
      if (customerId) (current as any).stripe.customerId = customerId;
      if (subscriptionId) (current as any).stripe.subscriptionId = subscriptionId;

      let period: { start: Date; end: Date; key: string };
      let planChangeCarryover: Record<string, number> | undefined;
      if (subscriptionId || (current as any).stripe.subscriptionId) {
        const subscription = await retrieveMembershipSubscription(
          accountId,
          subscriptionId || (current as any).stripe.subscriptionId,
        );
        const nextStatus = membershipStatusFromSubscription(subscription);
        if (![MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED].includes(nextStatus as any)) {
          if (nextStatus === MEMBERSHIP_STATUS.CANCELLED) {
            await terminalizeMembership({
              tenantId: String(current.tenant),
              membership: current,
              status: MEMBERSHIP_STATUS.CANCELLED,
              reason: "stripe_subscription_cancelled",
              idempotencyPrefix: `stripe-subscription-cancelled:${subscription.id}`,
              session,
            });
            await recordMembershipAudit({
              tenantId: String(current.tenant),
              userId: String(current.user),
              membershipId: String(current._id),
              planId: String(current.plan),
              type: "membership.cancelled",
              source: eventMutationSource(event.id),
              metadata: { eventId: event.id, subscriptionId: subscription.id },
              session,
            });
            await enqueueMembershipNotification({
              tenantId: String(current.tenant),
              userId: String(current.user),
              membershipId: String(current._id),
              type: "cancelled",
              intentKey: `membership:${current._id}:stripe-cancelled:${subscription.id}`,
              session,
            });
            return;
          }
          current.status = nextStatus as any;
          current.isOpen = ![MEMBERSHIP_STATUS.CANCELLED, MEMBERSHIP_STATUS.EXPIRED].includes(nextStatus as any);
          await current.save({ session });
          return;
        }
        if (!invoice && event.id.startsWith("reconcile:")) {
          const latestInvoiceId = typeof subscription.latest_invoice === "string"
            ? subscription.latest_invoice : subscription.latest_invoice?.id;
          if (!latestInvoiceId) return;
          invoice = await syncMembershipInvoice({ membership: current, connectedAccountId: accountId,
            invoice: latestInvoiceId, source: { id: event.id, created: event.created } });
          // Active/trialing subscription status alone does not prove that the
          // period was paid. Reconciliation has the same proof requirement.
          if (invoice.status !== "paid") return;
        }
        if (!invoice) throw new Error("Recurring membership payment is missing its paid invoice.");
        period = periodFromPaidMembershipInvoice(invoice, subscription.id);
        // An older payment cannot rewind the paid period or replenish a newer
        // allowance after the provider has moved to the next billing period.
        if ((current.currentPeriodStart && period.start < current.currentPeriodStart) ||
            period.start.getTime() < subscription.current_period_start * 1000) return;
        const planChange = await applyPaidMembershipPlanChange({ membership: current, invoice, subscriptionId: subscription.id,
          periodStart: period.start, periodEnd: period.end, session });
        current = planChange.membership;
        planChangeCarryover = planChange.carryover;
        appliedChange = planChange.appliedChange;
        if (!current) return;
        current.status = nextStatus as any;
        current.cancelAtPeriodEnd = subscription.cancel_at_period_end;
        current.cancelScheduledAt = subscription.cancel_at_period_end ? new Date() : null;
        current.autoRenew = !subscription.cancel_at_period_end;
      } else {
        // Replays reuse the established fixed period. On first confirmation,
        // start the sold duration at payment time rather than Session creation.
        period = fixedPeriodFromPaymentConfirmation({
          membership: current,
          eventCreated: event.created,
          invoicePaidAt: invoice?.status_transitions?.paid_at,
        });
        current.status = MEMBERSHIP_STATUS.ACTIVE;
        current.autoRenew = false;
      }
      current.startedAt ??= period.start;
      current.currentPeriodStart = period.start;
      current.currentPeriodEnd = period.end;
      current.renewsAt = period.end;
      current.isOpen = true;
      (current as any).stripe.lastEventCreated = Math.max(Number((current as any).stripe.lastEventCreated ?? 0), event.created);
      (current as any).stripe.lastEventId = event.id;
      (current as any).stripe.lastSyncedAt = new Date();
      await current.save({ session });
      const granted = await grantMembershipPeriodEntitlements({ membership: current, periodStart: period.start, periodEnd: period.end, periodKey: period.key, session, planChangeCarryover });
      if (granted) {
        await recordMembershipAudit({
          tenantId: String(current.tenant),
          userId: String(current.user),
          membershipId: String(current._id),
          planId: String(current.plan),
          type: "membership.payment_confirmed",
          source: eventMutationSource(event.id),
          metadata: { eventId: event.id, periodKey: period.key },
          session,
        });
        await enqueueMembershipNotification({
          tenantId: String(current.tenant),
          userId: String(current.user),
          membershipId: String(current._id),
          type: wasPending ? "activated" : "renewed",
          intentKey: `membership:${current._id}:period-confirmed:${period.key}`,
          session,
        });
      }
    });
  } finally {
    await session.endSession();
  }
  if (appliedChange) {
    try {
      await releaseAppliedPlanChangeSchedule(accountId, (membership as any).stripe.subscriptionId, appliedChange);
    } catch (error) {
      logger.error({ err: error, membershipId: membership._id }, "Paid membership plan schedule release awaits reconciliation.");
    }
  }
};

const handleClaimedEvent = async (
  event: Stripe.Event,
  membership: any,
  accountId: string,
) => {
  const object: any = event.data.object;
  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    // A failure can arrive before invoice.payment_failed, or after a later
    // successful retry. Current Stripe state decides whether this is terminal.
    // A live recurring subscription must stay recoverable while it can charge.
    const checkout = await retrieveMembershipCheckoutSession(accountId, object.id);
    await recoverMembershipCheckout({ membership, checkout, connectedAccountId: accountId });
    return;
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    // Completion alone is never sufficient. Stripe must explicitly report the
    // payment as paid in this signed webhook payload.
    if (object.payment_status !== "paid") return;
    await applyPaymentConfirmed(event, membership, accountId);
    return;
  }
  if (event.type.startsWith("invoice.")) {
    const invoice = await syncMembershipInvoice({
      membership,
      connectedAccountId: accountId,
      invoice: (event.data.object as Stripe.Invoice).id,
      source: { id: event.id, created: event.created },
    });
    if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
      await applyPaymentConfirmed(event, membership, accountId, invoice);
    } else if (event.type === "invoice.payment_failed") {
      // The event can be delivered after a later recovery. Use current Stripe
      // invoice/subscription state instead of applying the stale payload.
      const subscriptionId = typeof invoice.subscription === "string"
        ? invoice.subscription
        : invoice.subscription?.id;
      const subscription = subscriptionId
        ? await retrieveMembershipSubscription(accountId, subscriptionId)
        : null;
      const currentStatus = subscription
        ? membershipStatusFromSubscription(subscription)
        : invoice.status === "paid"
          ? MEMBERSHIP_STATUS.ACTIVE
          : MEMBERSHIP_STATUS.PAST_DUE;
      if (currentStatus === MEMBERSHIP_STATUS.CANCELLED) {
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
              reason: "stripe_subscription_cancelled",
              idempotencyPrefix: `stripe-subscription-cancelled:${subscriptionId}`,
              session: terminalSession,
            });
            await enqueueMembershipNotification({
              tenantId: String(current.tenant),
              userId: String(current.user),
              membershipId: String(current._id),
              type: "cancelled",
              intentKey: `membership:${current._id}:stripe-cancelled:${subscriptionId}`,
              session: terminalSession,
            });
          });
        } finally {
          await terminalSession.endSession();
        }
      } else {
        const paymentSession = await mongoose.startSession();
        try {
          await paymentSession.withTransaction(async () => {
            const current = await UserMembershipModel.findOne({
              _id: membership._id,
              isOpen: true,
            }).select("+stripe.lastEventCreated").session(paymentSession).exec();
            if (!current) return;
            current.status = statusWithoutUnpaidActivation(current, currentStatus) as any;
            current.isOpen = true;
            current.cancelAtPeriodEnd = subscription?.cancel_at_period_end ?? false;
            current.autoRenew = subscription ? !subscription.cancel_at_period_end : true;
            if (subscription) {
              // An initial failure can precede Checkout completion. Persist
              // the provider identity so cancellation also stops future billing.
              (current as any).stripe.subscriptionId = subscription.id;
              (current as any).stripe.customerId = typeof subscription.customer === "string"
                ? subscription.customer : subscription.customer.id;
            }
            // Failed invoices/subscription snapshots cannot extend a paid term.
            current.renewsAt = subscription
              ? new Date(subscription.current_period_end * 1000)
              : membership.renewsAt;
            (current as any).stripe.lastSyncedAt = new Date();
            (current as any).stripe.lastEventCreated = Math.max(
              Number((current as any).stripe.lastEventCreated ?? 0),
              event.created,
            );
            await current.save({ session: paymentSession });
            if (currentStatus === MEMBERSHIP_STATUS.PAST_DUE) {
              await enqueueMembershipNotification({
                tenantId: String(current.tenant),
                userId: String(current.user),
                membershipId: String(current._id),
                type: "payment_failed",
                intentKey: `membership:${current._id}:payment-failed:${object.id}`,
                session: paymentSession,
              });
            }
          });
        } finally {
          await paymentSession.endSession();
        }
      }
    }
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    // Always retrieve the current connected-account object. This makes stale
    // delivery order harmless: an old event can only write Stripe's current state.
    const subscription = await retrieveMembershipSubscription(
      accountId,
      object.id,
    );
    const status = membershipStatusFromSubscription(subscription);
    const subscriptionState = {
      renewsAt: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelScheduledAt: subscription.cancel_at_period_end ? new Date() : null,
      cancelledAt: status === MEMBERSHIP_STATUS.CANCELLED ? new Date() : null,
      autoRenew:
        !subscription.cancel_at_period_end &&
        status !== MEMBERSHIP_STATUS.CANCELLED,
      "stripe.subscriptionId": subscription.id,
      "stripe.customerId":
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id,
      "stripe.lastSyncedAt": new Date(),
    };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await UserMembershipModel.findById(membership._id)
          .select(
            "+stripe.subscriptionId +stripe.customerId +stripe.lastEventCreated +stripe.lastEventId",
          )
          .session(session)
          .exec();
        // A delayed provider event cannot reopen a cancelled/expired local
        // membership (or overwrite a concurrent payment transaction).
        if (!current?.isOpen) return;
        if (status === MEMBERSHIP_STATUS.CANCELLED) {
          await terminalizeMembership({
            tenantId: String(current.tenant),
            membership: current,
            status: MEMBERSHIP_STATUS.CANCELLED,
            reason: "stripe_subscription_cancelled",
            idempotencyPrefix: `stripe-subscription-cancelled:${subscription.id}`,
            session,
          });
        } else {
          current.status = statusWithoutUnpaidActivation(
            current,
            status,
          ) as any;
        }
        current.set(subscriptionState);
        (current as any).stripe.lastEventCreated = Math.max(
          Number((current as any).stripe.lastEventCreated ?? 0),
          event.created,
        );
        (current as any).stripe.lastEventId = event.id;
        await current.save({ session });
        await recoverMembershipBillingMutation(current, subscription, session);
        if (status === MEMBERSHIP_STATUS.CANCELLED) {
          await recordMembershipAudit({
            tenantId: String(current.tenant),
            userId: String(current.user),
            membershipId: String(current._id),
            planId: String(current.plan),
            type: "membership.cancelled",
            source: "webhook",
            metadata: { eventId: event.id, subscriptionId: subscription.id },
            session,
          });
          await enqueueMembershipNotification({
            tenantId: String(current.tenant),
            userId: String(current.user),
            membershipId: String(current._id),
            type: "cancelled",
            intentKey: `membership:${current._id}:stripe-cancelled:${subscription.id}`,
            session,
          });
        }
      });
    } finally {
      await session.endSession();
    }
  }
};

export const handleMembershipStripeEvent = async (event: Stripe.Event): Promise<boolean> => {
  if (!isMembershipStripeEvent(event)) return false;
  const accountId = connectedAccountId(event);
  if (!accountId) throw new Error("Membership Stripe event is missing its connected account.");
  const account = await findTenantPaymentAccountByStripeAccount(accountId);
  if (!account) {
    logger.warn({ eventId: event.id, accountId }, "Ignored membership event for unknown connected account.");
    return true;
  }
  const tenantId = String(account.tenant);
  const membership = await findMembershipForEvent(event, accountId, tenantId);
  if (!membership) {
    // Invoice traffic for order checkout shares this endpoint; allow the order
    // dispatcher to inspect invoices that are not mapped to a membership.
    return false;
  }
  assertEventOwnership(event, membership, tenantId);
  const claim = await claimEvent(event, accountId);
  if (!claim) return true;
  try {
    await handleClaimedEvent(event, membership, accountId);
    await markProcessed(claim.record._id, claim.token);
  } catch (error) {
    await markFailed(claim.record._id, claim.token, error);
    throw error;
  }
  return true;
};

export const membershipWebhookService = {
  shouldProcess: isMembershipStripeEvent,
  processEvent: handleMembershipStripeEvent,
};

export default membershipWebhookService;
