import type Stripe from "stripe";
import mongoose, { type ClientSession } from "mongoose";

import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";
import {
  getTenantOrThrow,
  updateTenantPlan,
} from "@/modules/tenants/services/tenant.service.js";
import {
  isPlatformBillingCurrency,
  type PlatformBillingCurrency,
} from "@/shared/money/currency.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";

import {
  PAYMENT_GRACE_DAYS,
  TENANT_SUBSCRIPTION_STATUS,
} from "../tenant-subscription.constants.js";
import {
  findSubscriptionByStripeCustomer,
  findSubscriptionByStripeSubscription,
  findSubscriptionByTenant,
} from "../tenant-subscription.repository.js";
import type { InvoicePaymentRecoveryUpdate } from "../tenant-subscription.payment-recovery.js";
import type {
  TenantSubscriptionDocument,
  TenantSubscriptionStatus,
} from "../tenant-subscription.types.js";
import { assertStripeSubscriptionContract } from "../tenant-subscription.stripe-contract.js";
import TenantSubscriptionModel from "../tenant-subscription.schema.js";

export type SubscriptionPaymentNotificationKind = "failed" | "recovered";

const paymentProblemStatuses = new Set<TenantSubscriptionStatus>([
  TENANT_SUBSCRIPTION_STATUS.PAST_DUE,
  TENANT_SUBSCRIPTION_STATUS.UNPAID,
]);

const paymentHealthyStatuses = new Set<TenantSubscriptionStatus>([
  TENANT_SUBSCRIPTION_STATUS.ACTIVE,
  TENANT_SUBSCRIPTION_STATUS.TRIALING,
]);

export const getSubscriptionPaymentNotificationKind = ({
  previousStatus,
  nextStatus,
  paymentRecoveryState,
}: {
  previousStatus: TenantSubscriptionStatus;
  nextStatus: TenantSubscriptionStatus;
  paymentRecoveryState?: InvoicePaymentRecoveryUpdate["state"] | null;
}): SubscriptionPaymentNotificationKind | null => {
  if (
    paymentRecoveryState === "failed" ||
    paymentRecoveryState === "terminal"
  ) {
    return "failed";
  }
  if (paymentRecoveryState === "recovered") return "recovered";
  if (previousStatus !== nextStatus && paymentProblemStatuses.has(nextStatus)) {
    return "failed";
  }
  if (
    previousStatus !== nextStatus &&
    paymentProblemStatuses.has(previousStatus) &&
    paymentHealthyStatuses.has(nextStatus)
  ) {
    return "recovered";
  }
  return null;
};

const emitSubscriptionPaymentNotificationEvent = ({
  local,
  previousStatus,
  nextStatus,
  paymentRecoveryState,
  notificationIdentity,
}: {
  local: TenantSubscriptionDocument;
  previousStatus: TenantSubscriptionStatus;
  nextStatus: TenantSubscriptionStatus;
  paymentRecoveryState?: InvoicePaymentRecoveryUpdate["state"] | null;
  notificationIdentity: string;
}): void => {
  const kind = getSubscriptionPaymentNotificationKind({
    previousStatus,
    nextStatus,
    paymentRecoveryState,
  });
  if (!kind) return;

  const failed = kind === "failed";
  const subscriptionId = String(local._id);
  emitWorkspaceNotificationEvent({
    tenantId: String(local.tenant),
    requiredPermission: WORKSPACE_PERMISSION.SUBSCRIPTION_VIEW,
    eventType: failed
      ? "subscription.payment_failed"
      : "subscription.payment_recovered",
    category: "account",
    severity: failed ? "critical" : "success",
    title: failed
      ? {
          en: "Subscription payment needs attention",
          cs: "Platba předplatného vyžaduje pozornost",
        }
      : {
          en: "Subscription payment recovered",
          cs: "Platba předplatného byla obnovena",
        },
    message: failed
      ? {
          en: "The workspace subscription payment failed. Review billing to prevent service interruption.",
          cs: "Platba předplatného pracovního prostoru selhala. Zkontrolujte fakturaci, aby nedošlo k přerušení služby.",
        }
      : {
          en: "The workspace subscription payment is healthy again.",
          cs: "Platba předplatného pracovního prostoru je opět v pořádku.",
        },
    actionUrl: "/app/settings/billing",
    sourceType: "tenant-subscription",
    sourceId: subscriptionId,
    deduplicationKey:
      "tenant-subscription:" +
      subscriptionId +
      ":payment:" +
      notificationIdentity +
      ":" +
      kind,
    groupKey: "subscription.payment",
  });
};

const dateFromSeconds = (value: number | null | undefined): Date | undefined =>
  value ? new Date(value * 1000) : undefined;

export const mapStripeSubscriptionStatus = (
  status: Stripe.Subscription.Status,
): TenantSubscriptionStatus => {
  const mapping: Record<Stripe.Subscription.Status, TenantSubscriptionStatus> =
    {
      active: TENANT_SUBSCRIPTION_STATUS.ACTIVE,
      canceled: TENANT_SUBSCRIPTION_STATUS.CANCELED,
      incomplete: TENANT_SUBSCRIPTION_STATUS.INCOMPLETE,
      incomplete_expired: TENANT_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
      past_due: TENANT_SUBSCRIPTION_STATUS.PAST_DUE,
      paused: TENANT_SUBSCRIPTION_STATUS.PAUSED,
      trialing: TENANT_SUBSCRIPTION_STATUS.TRIALING,
      unpaid: TENANT_SUBSCRIPTION_STATUS.UNPAID,
    };

  return mapping[status];
};

const getBillingCurrency = (
  stripeSubscription: Stripe.Subscription,
  metadataCurrency: string | undefined,
  priceCurrency: string | undefined,
): PlatformBillingCurrency | null => {
  for (const value of [
    stripeSubscription.currency,
    metadataCurrency,
    priceCurrency,
  ]) {
    const currency = value?.toUpperCase();

    if (isPlatformBillingCurrency(currency)) return currency;
  }

  return null;
};

const getCustomerId = (subscription: Stripe.Subscription): string => {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
};

const getScheduleId = (
  subscription: Stripe.Subscription,
): string | undefined => {
  if (!subscription.schedule) return undefined;

  return typeof subscription.schedule === "string"
    ? subscription.schedule
    : subscription.schedule.id;
};

const applyPaymentRecovery = (
  local: TenantSubscriptionDocument,
  paymentRecovery: InvoicePaymentRecoveryUpdate,
  occurredAt: Date,
): void => {
  if (paymentRecovery.state === "recovered") {
    local.lastPaymentFailedAt = undefined;
    local.paymentRetryCount = undefined;
    local.nextPaymentAttemptAt = undefined;
    local.paymentRecoveryUrl = undefined;
    local.paymentFailureReason = undefined;
    local.graceEndsAt = undefined;
    return;
  }

  if (
    paymentRecovery.state === "failed" ||
    paymentRecovery.state === "terminal"
  ) {
    local.lastPaymentFailedAt = occurredAt;
  }

  local.paymentRetryCount = paymentRecovery.attemptCount;
  local.nextPaymentAttemptAt = paymentRecovery.nextPaymentAttemptAt;
  local.paymentRecoveryUrl = paymentRecovery.recoveryUrl;

  if (paymentRecovery.failureReason) {
    local.paymentFailureReason = paymentRecovery.failureReason;
  }
};

export const resolveLocalTenantSubscription = async (
  stripeSubscription: Stripe.Subscription,
): Promise<TenantSubscriptionDocument> => {
  const tenantId = stripeSubscription.metadata?.tenantId;
  const customerId = getCustomerId(stripeSubscription);

  const local =
    (await findSubscriptionByStripeSubscription(stripeSubscription.id)) ??
    (await findSubscriptionByStripeCustomer(customerId)) ??
    (tenantId ? await findSubscriptionByTenant(tenantId) : null);

  if (!local) {
    notFound("No tenant subscription matches this Stripe subscription.");
  }

  return local;
};

type CompletedTenantCheckout = {
  id: string;
  tenantId: string;
  customerId: string;
  subscriptionId: string;
};

type SnapshotInput = {
  stripeSubscription: Stripe.Subscription;
  eventId?: string;
  eventCreatedAt?: number;
  latestInvoiceId?: string;
  paymentRecovery?: InvoicePaymentRecoveryUpdate | null;
  // Supplied only by the signature-verified checkout.session.completed handler.
  completedCheckout?: CompletedTenantCheckout;
};

type SnapshotResult = {
  subscription: TenantSubscriptionDocument;
  hadPaymentFailure: boolean;
  paymentEventApplied: boolean;
  notification?: Parameters<typeof emitSubscriptionPaymentNotificationEvent>[0];
};

const isCurrentOrCompletedCheckout = (
  local: TenantSubscriptionDocument,
  { stripeSubscription, completedCheckout }: SnapshotInput,
): boolean => {
  const customerId = getCustomerId(stripeSubscription);
  const tenantId = String(local.tenant);
  if (
    (stripeSubscription.metadata?.tenantId &&
      stripeSubscription.metadata.tenantId !== tenantId) ||
    (local.stripe.customerId && local.stripe.customerId !== customerId) ||
    (completedCheckout &&
      (completedCheckout.tenantId !== tenantId ||
        completedCheckout.customerId !== customerId ||
        completedCheckout.subscriptionId !== stripeSubscription.id))
  ) {
    conflict("Stripe subscription identity does not match the workspace.");
  }

  const currentId = local.stripe.subscriptionId;
  if (currentId === stripeSubscription.id) return true;

  // Metadata alone cannot turn a manual grant into paid service or rebind a
  // replacement subscription. Checkout first persists this tenant's Customer.
  if (
    !completedCheckout?.id ||
    completedCheckout.tenantId !== tenantId ||
    completedCheckout.customerId !== customerId ||
    completedCheckout.subscriptionId !== stripeSubscription.id ||
    local.stripe.customerId !== customerId ||
    stripeSubscription.metadata?.tenantId !== tenantId
  )
    return false;

  if (!currentId) return true;
  if (
    ![
      TENANT_SUBSCRIPTION_STATUS.CANCELED,
      TENANT_SUBSCRIPTION_STATUS.EXPIRED,
      TENANT_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
    ].some((status) => status === local.status)
  )
    return false;

  // Legacy projections already store their current period start. It is a
  // conservative lower bound for a genuine replacement's creation time.
  const previousCreatedAt =
    local.stripe.subscriptionCreatedAt ??
    (local.currentPeriodStart
      ? Math.floor(local.currentPeriodStart.getTime() / 1000)
      : undefined);
  return (
    Number.isFinite(stripeSubscription.created) &&
    previousCreatedAt !== undefined &&
    stripeSubscription.created > previousCreatedAt
  );
};

const projectStripeSubscriptionSnapshot = async ({
  stripeSubscription,
  eventId,
  eventCreatedAt,
  latestInvoiceId,
  paymentRecovery,
  local,
  session,
}: SnapshotInput & {
  local: TenantSubscriptionDocument;
  session: ClientSession;
}): Promise<SnapshotResult> => {
  // Validate the immutable catalogue selection before touching either the
  // subscription snapshot or the tenant's effective entitlements.
  const priceSelection = assertStripeSubscriptionContract({
    stripeSubscription,
  });

  const hadPaymentFailure = Boolean(local.lastPaymentFailedAt);
  let notification: SnapshotResult["notification"];
  const previousStatus = local.status;
  const mappedStatus = mapStripeSubscriptionStatus(stripeSubscription.status);
  const now = new Date();
  const notificationIdentity = String(
    latestInvoiceId ??
      eventId ??
      eventCreatedAt ??
      stripeSubscription.id + ":" + stripeSubscription.current_period_end,
  );
  const paymentOccurredAt = eventCreatedAt
    ? new Date(eventCreatedAt * 1000)
    : now;
  const isFreshPaymentEvent = Boolean(
    paymentRecovery &&
    (eventCreatedAt === undefined ||
      local.lastPaymentEventCreatedAt === undefined ||
      eventCreatedAt >= local.lastPaymentEventCreatedAt),
  );

  if (
    eventCreatedAt !== undefined &&
    local.lastStripeEventCreatedAt !== undefined &&
    eventCreatedAt < local.lastStripeEventCreatedAt
  ) {
    // Subscription and invoice events can be delivered out of order. Never
    // project an older subscription snapshot, but still retain a newer invoice
    // recovery event according to its own ordering cursor.
    if (paymentRecovery && isFreshPaymentEvent) {
      applyPaymentRecovery(local, paymentRecovery, paymentOccurredAt);
      local.lastPaymentEventCreatedAt = eventCreatedAt;
      if (latestInvoiceId) local.latestInvoiceId = latestInvoiceId;
      if (eventId) local.lastWebhookEventId = eventId;
      local.lastSyncedAt = now;
      await local.save({ session });
      notification = {
        local,
        previousStatus,
        nextStatus: mappedStatus,
        paymentRecoveryState: paymentRecovery.state,
        notificationIdentity,
      };
    }

    return {
      subscription: local,
      hadPaymentFailure,
      paymentEventApplied: isFreshPaymentEvent,
      notification,
    };
  }

  const item = stripeSubscription.items.data[0];
  const priceId = item?.price?.id;
  const priceLookupKey = item?.price?.lookup_key ?? undefined;
  const offerId =
    priceSelection?.offerId ?? stripeSubscription.metadata?.offerId;
  const plan = priceSelection.plan;
  const planVersion = priceSelection.planVersion;
  const interval = priceSelection.billingInterval;
  const billingCurrency = getBillingCurrency(
    stripeSubscription,
    stripeSubscription.metadata?.billingCurrency,
    item?.price?.currency,
  );
  local.status = mappedStatus;
  if (plan) local.billingPlan = plan;
  if (planVersion) local.planVersion = planVersion;
  local.billingInterval = interval;
  if (billingCurrency) local.billingCurrency = billingCurrency;
  local.currentPeriodStart = dateFromSeconds(
    stripeSubscription.current_period_start,
  );
  local.currentPeriodEnd = dateFromSeconds(
    stripeSubscription.current_period_end,
  );
  local.trialStartedAt =
    dateFromSeconds(stripeSubscription.trial_start) ?? local.trialStartedAt;
  local.trialEndsAt =
    dateFromSeconds(stripeSubscription.trial_end) ?? local.trialEndsAt;
  if (local.trialStartedAt && !local.trialUsedAt) {
    local.trialUsedAt = local.trialStartedAt;
  }
  local.cancelAtPeriodEnd = stripeSubscription.cancel_at_period_end;
  local.canceledAt = dateFromSeconds(stripeSubscription.canceled_at);
  local.endedAt = dateFromSeconds(stripeSubscription.ended_at);
  local.stripe.customerId = getCustomerId(stripeSubscription);
  local.stripe.subscriptionId = stripeSubscription.id;
  if (Number.isFinite(stripeSubscription.created)) {
    local.stripe.subscriptionCreatedAt = stripeSubscription.created;
  }
  local.stripe.priceId = priceId;
  local.stripe.priceLookupKey =
    priceLookupKey ?? stripeSubscription.metadata?.priceLookupKey;
  local.stripe.offerId = offerId || undefined;
  local.stripe.scheduleId = getScheduleId(stripeSubscription);
  if (latestInvoiceId) local.latestInvoiceId = latestInvoiceId;
  if (eventId) local.lastWebhookEventId = eventId;
  if (eventCreatedAt !== undefined) {
    local.lastStripeEventCreatedAt = eventCreatedAt;
  }
  local.lastSyncedAt = now;

  if (mappedStatus === TENANT_SUBSCRIPTION_STATUS.PAST_DUE) {
    local.graceEndsAt ??= new Date(
      now.getTime() + PAYMENT_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
  } else if (
    mappedStatus === TENANT_SUBSCRIPTION_STATUS.ACTIVE ||
    mappedStatus === TENANT_SUBSCRIPTION_STATUS.TRIALING
  ) {
    local.graceEndsAt = undefined;
  }

  if (paymentRecovery && isFreshPaymentEvent) {
    applyPaymentRecovery(local, paymentRecovery, paymentOccurredAt);
    if (eventCreatedAt !== undefined) {
      local.lastPaymentEventCreatedAt = eventCreatedAt;
    }
  }

  if (local.pendingChange && !stripeSubscription.pending_update) {
    const pendingChangeApplied =
      plan === local.pendingChange.plan &&
      planVersion === local.pendingChange.planVersion &&
      interval === local.pendingChange.billingInterval;
    const failedImmediateChange =
      !getScheduleId(stripeSubscription) &&
      local.pendingChange.effectiveAt.getTime() <= now.getTime();

    if (pendingChangeApplied || failedImmediateChange) {
      local.pendingChange = undefined;
    }
  }

  await local.save({ session });
  notification = {
    local,
    previousStatus,
    nextStatus: mappedStatus,
    paymentRecoveryState:
      paymentRecovery && isFreshPaymentEvent ? paymentRecovery.state : null,
    notificationIdentity,
  };

  const effectivePlan =
    mappedStatus === TENANT_SUBSCRIPTION_STATUS.TRIALING
      ? local.trialPlan
      : plan;
  const effectivePlanVersion =
    mappedStatus === TENANT_SUBSCRIPTION_STATUS.TRIALING
      ? local.trialPlanVersion
      : planVersion;

  if (
    effectivePlan &&
    effectivePlanVersion &&
    (mappedStatus === TENANT_SUBSCRIPTION_STATUS.TRIALING ||
      mappedStatus === TENANT_SUBSCRIPTION_STATUS.ACTIVE ||
      mappedStatus === TENANT_SUBSCRIPTION_STATUS.PAST_DUE)
  ) {
    const tenant = await getTenantOrThrow(String(local.tenant), { session });

    if (
      tenant.plan !== effectivePlan ||
      tenant.planVersion !== effectivePlanVersion
    ) {
      await updateTenantPlan(tenant, effectivePlan, {
        planVersion: effectivePlanVersion,
        session,
      });
    }
  }

  return {
    subscription: local,
    hadPaymentFailure,
    paymentEventApplied: isFreshPaymentEvent,
    notification,
  };
};

/**
 * Serialize the ordering decision and both projections in one transaction.
 * Distinct webhook IDs still contend on the same subscription document; a
 * conflict retries the read, so a late older snapshot cannot pass a stale cursor.
 */
export const syncStripeSubscriptionSnapshotWithResult = async (
  input: SnapshotInput,
): Promise<Omit<SnapshotResult, "notification">> => {
  assertStripeSubscriptionContract({
    stripeSubscription: input.stripeSubscription,
  });
  const candidate = await resolveLocalTenantSubscription(
    input.stripeSubscription,
  );
  const ignored = (
    subscription: TenantSubscriptionDocument,
  ): SnapshotResult => ({
    subscription,
    hadPaymentFailure: Boolean(subscription.lastPaymentFailedAt),
    paymentEventApplied: false,
  });
  if (!isCurrentOrCompletedCheckout(candidate, input))
    return ignored(candidate);

  const result = await mongoose.connection.transaction(async (session) => {
    // Raw collection access keeps the internal fencing revision out of DTOs.
    const locked = await TenantSubscriptionModel.collection.findOneAndUpdate(
      { _id: candidate._id },
      { $inc: { stripeSyncRevision: 1 } },
      { session, returnDocument: "after" },
    );
    if (!locked) notFound("Tenant subscription not found.");
    const local = await TenantSubscriptionModel.findById(candidate._id)
      .session(session)
      .exec();
    if (!local) notFound("Tenant subscription not found.");
    if (!isCurrentOrCompletedCheckout(local, input)) return ignored(local);

    if (local.stripe.subscriptionId !== input.stripeSubscription.id) {
      // Event-order cursors and recovery belong to one Stripe subscription.
      // A valid replacement must not inherit the previous subscription's debt.
      local.lastStripeEventCreatedAt = undefined;
      local.lastPaymentEventCreatedAt = undefined;
      local.latestInvoiceId = undefined;
      local.lastPaymentFailedAt = undefined;
      local.paymentRetryCount = undefined;
      local.nextPaymentAttemptAt = undefined;
      local.paymentRecoveryUrl = undefined;
      local.paymentFailureReason = undefined;
      local.graceEndsAt = undefined;
      local.pendingChange = undefined;
    }

    return projectStripeSubscriptionSnapshot({ ...input, local, session });
  });
  result.subscription.$session(null);
  if (result.notification) {
    emitSubscriptionPaymentNotificationEvent(result.notification);
  }
  return {
    subscription: result.subscription,
    hadPaymentFailure: result.hadPaymentFailure,
    paymentEventApplied: result.paymentEventApplied,
  };
};

export const syncStripeSubscriptionSnapshot = async (
  input: SnapshotInput,
): Promise<TenantSubscriptionDocument> =>
  (await syncStripeSubscriptionSnapshotWithResult(input)).subscription;
