import mongoose from "mongoose";
import { claimMembershipBillingMutation } from "../membership-billing-mutation.js";
import { plainMembershipTranslations } from "../membership.localization.js";

import UserModel from "@/modules/user/user.model.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import MembershipEntitlementBalanceModel from "../membership-entitlement-balance.schema.js";
import MembershipEntitlementLedgerModel from "../membership-entitlement-ledger.schema.js";
import MembershipInvoiceModel from "../membership-invoice.schema.js";
import MembershipPlanModel from "../membership-plan.model.js";
import MembershipPlanVersionModel from "../membership-plan-version.model.js";
import UserMembershipModel from "../user-membership.model.js";
import { membershipRepository } from "../membership.repository.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import {
  MEMBERSHIP_CANCELLATION_EFFECTIVE,
  MEMBERSHIP_PLAN_STATUS,
  MEMBERSHIP_PLAN_VERSION_STATUS,
  MEMBERSHIP_STATUS,
} from "../membership.constants.js";
import {
  serializeLedgerEntry,
  serializeMembership,
  serializeMembershipInvoice,
} from "../membership.serializers.js";
import {
  cancelMembershipSubscription,
  expireMembershipCheckoutSession,
  retrieveMembershipCheckoutSession,
  retrieveMembershipSubscription,
  updateMembershipSubscriptionCancellation,
} from "../membership.stripe.gateway.js";
import {
  adjustMembershipEntitlement,
  grantMembershipPeriodEntitlements,
} from "./membership-entitlement.service.js";
import { terminalizeMembership } from "./membership-lifecycle.service.js";
import { enqueueMembershipNotification } from "./membership-notification.service.js";
import { recoverMembershipCheckout } from "./membership-checkout-recovery.service.js";
import type { AssignMembershipInput, ListUserMembershipsInput } from "../membership.validators.js";
import { toObjectId } from "../membership.utils.js";

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertSnapshotScope = (membership: any, allowedLocationIds: AllowedWorkspaceLocationIds) => {
  const scope = membership.planSnapshot?.locationScope;
  if (scope?.type === "all") {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
  } else {
    // A plan can be sold at A+B while the purchased membership is bound to A.
    // Authorize against that immutable purchase choice. Only legacy snapshots
    // without selectedLocation fall back to the whole offered plan scope.
    const purchasedLocations = scope?.type === "selected" && membership.selectedLocation
      ? [String(membership.selectedLocation)]
      : (scope?.locationIds ?? []).map(String);
    assertLocationIdsWithinWorkspaceScope(purchasedLocations, allowedLocationIds);
  }
};

/** A pending membership cannot close while its Checkout can still take payment. */
export const prepareMembershipCancellation = async (membership: any) => {
  const neverPaidCheckout = !membership.startedAt && !membership.currentPeriodStart &&
    membership.stripe?.checkoutSessionId &&
    [MEMBERSHIP_STATUS.PAST_DUE, MEMBERSHIP_STATUS.PAUSED].includes(membership.status);
  if (membership.status !== MEMBERSHIP_STATUS.PENDING && !neverPaidCheckout) return membership;
  const accountId = membership.stripe?.connectedAccountId;
  const checkoutId = membership.stripe?.checkoutSessionId;
  if (!accountId || !checkoutId) {
    conflict({
      message: "Membership checkout is still being prepared. Try cancellation again shortly.",
      code: "MEMBERSHIP_CHECKOUT_CANCELLATION_PENDING",
    });
  }
  let checkout = await retrieveMembershipCheckoutSession(accountId, checkoutId);
  if (checkout.status === "open") {
    try {
      await expireMembershipCheckoutSession(accountId, checkout.id);
      return membership;
    } catch (error) {
      // Payment can complete between retrieval and expiration. Determine its
      // current state before deciding whether the local membership can close.
      checkout = await retrieveMembershipCheckoutSession(accountId, checkoutId);
      if (checkout.status === "open") throw error;
    }
  }
  if (checkout.status === "expired") return membership;
  if (checkout.status === "complete" && checkout.payment_status === "paid") {
    await recoverMembershipCheckout({ membership, checkout, connectedAccountId: accountId });
    const recovered = await membershipRepository.findUserMembershipById(
      String(membership.tenant), String(membership._id), true,
    );
    if (recovered && recovered.status !== MEMBERSHIP_STATUS.PENDING &&
        recovered.currentPeriodStart && recovered.currentPeriodEnd) return recovered;
  }
  if (checkout.status === "complete" && checkout.payment_status === "unpaid" && checkout.subscription) {
    const subscription = typeof checkout.subscription === "string"
      ? await retrieveMembershipSubscription(accountId, checkout.subscription)
      : checkout.subscription;
    const invoice = typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
    const paymentIntent = typeof invoice?.payment_intent === "object" ? invoice.payment_intent : null;
    const terminalSubscription = ["canceled", "incomplete_expired"].includes(subscription.status);
    const confirmedFailure = paymentIntent?.status !== "processing" &&
      (invoice?.status === "void" || ["requires_payment_method", "canceled"].includes(paymentIntent?.status));
    if (terminalSubscription || confirmedFailure) {
      // A failed asynchronous first payment can leave a live subscription.
      // Carry its verified identity to cancel(), which stops remote collection
      // before closing the unpaid local record. Processing payments still wait.
      membership.stripe.subscriptionId = terminalSubscription ? "" : subscription.id;
      return membership;
    }
  }
  // An asynchronous payment may still settle. Keep its membership recoverable
  // instead of accepting a cancellation that leaves a charge without benefits.
  conflict({
    message: "Membership payment is being confirmed. Try cancellation again after the payment status updates.",
    code: "MEMBERSHIP_PAYMENT_CONFIRMATION_PENDING",
  });
};

const assertVersionLocation = (version: any, locationId?: string): mongoose.Types.ObjectId | null => {
  const scope = version.locationScope;
  if (scope.type === "selected") {
    if (!locationId || !(scope.locationIds ?? []).map(String).includes(locationId)) {
      conflict({ message: "Select a location offered by this membership plan.", code: "MEMBERSHIP_LOCATION_REQUIRED" });
    }
    return toObjectId(locationId);
  }
  if (locationId) {
    conflict({ message: "A location cannot be selected for an all-location membership.", code: "MEMBERSHIP_LOCATION_NOT_APPLICABLE" });
  }
  return null;
};

const periodEndFromBilling = (billing: any, start: Date): Date => {
  const end = new Date(start);
  if (billing.type === "fixed") {
    end.setUTCDate(end.getUTCDate() + Number(billing.durationDays));
  } else {
    const day = end.getUTCDate();
    const months = Number(billing.intervalCount) * (billing.interval === "year" ? 12 : 1);
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
  }
  return end;
};

export const membershipPlanSnapshot = (version: any) => ({
  version: Number(version.version),
  name: version.name,
  description: version.description ?? "",
  terms: version.terms ?? "",
  sourceLanguage: version.sourceLanguage,
  translations: version.translations ? plainMembershipTranslations(version.translations) : undefined,
  prices: version.prices.map((price: any) => ({
    currency: price.currency,
    amountMinor: Number(price.amountMinor),
  })),
  billing: version.billing.type === "fixed"
    ? { type: "fixed", durationDays: Number(version.billing.durationDays) }
    : {
        type: "recurring",
        interval: version.billing.interval,
        intervalCount: Number(version.billing.intervalCount),
      },
  locationScope: {
    type: version.locationScope.type,
    locationIds: (version.locationScope.locationIds ?? []).map(toObjectId),
  },
  benefits: version.benefits.map((benefit: any) => {
    const plain = benefit.toObject?.() ?? { ...benefit };
    delete plain._id;
    if (plain.translations) plain.translations = plainMembershipTranslations(plain.translations);
    return plain;
  }),
});

const balancesFor = (membershipId: unknown) =>
  MembershipEntitlementBalanceModel.find({ membership: membershipId })
    .sort({ benefitKey: 1 })
    .lean()
    .exec();

export const userMembershipService = {
  async list(
    tenantId: string,
    input: ListUserMembershipsInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    let userIds: string[] | undefined;
    if (input.search) {
      const normalizedSearch = input.search.trim();
      const query = new RegExp(escapeRegex(normalizedSearch), "i");
      const parsedMemberNumber = /^\d+$/.test(normalizedSearch)
        ? Number(normalizedSearch)
        : null;
      const users = await UserModel.find({
        tenant: toObjectId(tenantId),
        $or: [
          { firstname: query },
          { lastname: query },
          { email: query },
          { customId: query },
          ...(parsedMemberNumber !== null &&
          Number.isSafeInteger(parsedMemberNumber) &&
          parsedMemberNumber > 0
            ? [{ memberNumber: parsedMemberNumber }]
            : []),
        ],
      }).select("_id").lean().exec();
      userIds = users.map((user: any) => String(user._id));
    }
    const filters = {
      tenantId,
      userId: input.userId,
      userIds,
      planId: input.planId,
      allowedLocationIds,
      status: input.status,
      page: input.page,
      limit: input.limit,
    };
    const [memberships, total] = await Promise.all([
      membershipRepository.listUserMemberships(filters),
      membershipRepository.countUserMemberships(filters),
    ]);
    return {
      memberships: memberships.map((membership: any) => serializeMembership(membership)),
      total,
      page: input.page,
      pages: Math.ceil(total / input.limit),
    };
  },

  async detail(
    tenantId: string,
    membershipId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const membership = await UserMembershipModel.findOne({
      _id: toObjectId(membershipId), tenant: toObjectId(tenantId),
    }).populate("user", "firstname lastname email customId memberNumber").exec();
    if (!membership) notFound("Membership not found.");
    assertSnapshotScope(membership, allowedLocationIds);
    return serializeMembership(membership, await balancesFor(membership._id));
  },

  async getActiveForUser(
    tenantId: string,
    userId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const membership = await membershipRepository.findActiveUserMembership(tenantId, userId);
    if (!membership) return null;
    assertSnapshotScope(membership, allowedLocationIds);
    return serializeMembership(membership, await balancesFor(membership._id));
  },

  async mine(tenantId: string, userId: string) {
    const membership = await membershipRepository.findOpenUserMembership(tenantId, userId, { includeStripe: true }) ??
      await UserMembershipModel.findOne({ tenant: toObjectId(tenantId), user: toObjectId(userId) })
        .sort({ createdAt: -1 }).exec();
    return membership
      ? serializeMembership(membership, await balancesFor(membership._id))
      : null;
  },

  async assign(
    tenantId: string,
    input: AssignMembershipInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
  ) {
    const session = await mongoose.startSession();
    try {
      let membership: any;
      await session.withTransaction(async () => {
        // Mongo transactions do not support concurrent commands on one session.
        const user = await UserModel.findOne({ _id: toObjectId(input.userId), tenant: toObjectId(tenantId) }).session(session).exec();
        const plan = await MembershipPlanModel.findOne({
            _id: toObjectId(input.planId),
            tenant: toObjectId(tenantId),
            status: MEMBERSHIP_PLAN_STATUS.PUBLISHED,
          }).session(session).exec();
        if (!user) notFound("User not found.");
        if (!plan?.currentPublishedVersion) notFound("Published membership plan not found.");
        const versionId = input.planVersionId ?? String(plan.currentPublishedVersion);
        const version = await MembershipPlanVersionModel.findOne({
          _id: toObjectId(versionId),
          tenant: toObjectId(tenantId),
          plan: plan._id,
          status: MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED,
        }).session(session).exec();
        if (!version) notFound("Published membership plan version not found.");
        if (version.locationScope.type === "all") assertCanAccessAllWorkspaceLocations(allowedLocationIds);
        else assertLocationIdsWithinWorkspaceScope(version.locationScope.locationIds.map(String), allowedLocationIds);
        const selectedLocation = assertVersionLocation(version, input.locationId);
        const price = version.prices.find((candidate: any) => candidate.currency === input.currency);
        if (!price) conflict({ message: "The membership is not offered in this currency.", code: "MEMBERSHIP_CURRENCY_NOT_OFFERED" });
        const start = new Date();
        const periodEnd = input.renewsAt ?? periodEndFromBilling(version.billing, start);
        [membership] = await UserMembershipModel.create([{
          tenant: toObjectId(tenantId),
          user: user._id,
          plan: plan._id,
          planVersion: version._id,
          planSnapshot: membershipPlanSnapshot(version),
          selectedLocation,
          currency: input.currency,
          amountMinor: price.amountMinor,
          status: MEMBERSHIP_STATUS.ACTIVE,
          isOpen: true,
          startedAt: start,
          currentPeriodStart: start,
          currentPeriodEnd: periodEnd,
          renewsAt: periodEnd,
          // Offline/manual assignment has no payment authority capable of
          // confirming a renewal. It therefore always ends after this period.
          autoRenew: false,
          assignedBy: actorId ? toObjectId(actorId) : null,
          assignmentSource: "owner",
          assignmentReason: input.reason,
          assignmentNote: input.note,
        }], { session });
        await grantMembershipPeriodEntitlements({
          membership,
          periodStart: start,
          periodEnd,
          periodKey: `manual:${membership._id}:${start.toISOString()}`,
          session,
        });
        await recordMembershipAudit({
          tenantId,
          actorId,
          userId: input.userId,
          membershipId: String(membership._id),
          planId: input.planId,
          type: "membership.assigned",
          source: "owner",
          metadata: { reason: input.reason, note: input.note },
          session,
        });
        await enqueueMembershipNotification({
          tenantId,
          userId: input.userId,
          membershipId: String(membership._id),
          type: "assigned",
          intentKey: `membership:${membership._id}:assigned`,
          session,
        });
      });
      const serialized = serializeMembership(membership, await balancesFor(membership._id));
      return serialized;
    } catch (error: any) {
      if (error?.code === 11000) {
        conflict({ message: "User already has an open membership.", code: "MEMBERSHIP_ALREADY_OPEN" });
      }
      throw error;
    } finally {
      await session.endSession();
    }
  },

  async adjust(
    tenantId: string,
    membershipId: string,
    input: { benefitKey: string; delta: number; reason: string; note?: string; idempotencyKey?: string },
    actorId: string,
    headerIdempotencyKey?: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const membership = await membershipRepository.findUserMembershipById(tenantId, membershipId);
    if (!membership) notFound("Membership not found.");
    assertSnapshotScope(membership, allowedLocationIds);
    const idempotencyKey = headerIdempotencyKey?.trim() || input.idempotencyKey?.trim();
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 160) {
      conflict({ message: "A valid Idempotency-Key is required.", code: "MEMBERSHIP_IDEMPOTENCY_KEY_REQUIRED" });
    }
    const entry = await adjustMembershipEntitlement({
      tenantId,
      membershipId,
      benefitKey: input.benefitKey,
      delta: input.delta,
      reason: input.reason,
      note: input.note,
      actorId,
      idempotencyKey,
    });
    await recordMembershipAudit({ tenantId, actorId, userId: String(membership.user), membershipId, planId: String(membership.plan), type: "membership.entitlement.adjusted", source: "owner", metadata: { benefitKey: input.benefitKey, delta: input.delta, reason: input.reason } });
    return {
      membership: serializeMembership(membership, await balancesFor(membership._id)),
      entry: serializeLedgerEntry(entry),
    };
  },

  async cancel(
    tenantId: string,
    membershipId: string,
    input: { effective: string; reason: string; comment?: string },
    actorId: string,
    source: "owner" | "customer" = "owner",
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    let membership = await membershipRepository.findUserMembershipById(tenantId, membershipId, true);
    if (!membership || !membership.isOpen) notFound("Open membership not found.");
    assertSnapshotScope(membership, allowedLocationIds);
    membership = await prepareMembershipCancellation(membership);
    if (!membership.isOpen) notFound("Open membership not found.");
    const stripe = (membership as any).stripe;
    const now = new Date();
    const periodEnd = input.effective === MEMBERSHIP_CANCELLATION_EFFECTIVE.PERIOD_END &&
      Boolean(membership.currentPeriodEnd && membership.currentPeriodEnd > now);
    let billingMutationKey: string | null = null;
    if (stripe?.subscriptionId) {
      if (!stripe.connectedAccountId) throw new Error("Membership subscription is missing its connected account.");
      const mutationKey = await claimMembershipBillingMutation(membership, "cancel", {
        ...input, effective: periodEnd ? "period_end" : "immediate",
      });
      billingMutationKey = mutationKey;
      if (periodEnd) {
        await updateMembershipSubscriptionCancellation(
          stripe.connectedAccountId,
          stripe.subscriptionId,
          true,
          `membership-cancel-period-${membership._id}-${mutationKey}`,
        );
      } else {
        await cancelMembershipSubscription(
          stripe.connectedAccountId,
          stripe.subscriptionId,
          `membership-cancel-now-${membership._id}-${mutationKey}`,
        );
      }
    }
    let actuallyScheduled = false;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await UserMembershipModel.findOne({ _id: membership._id,
          ...(billingMutationKey ? { billingMutation: billingMutationKey } : {}) }).session(session).exec();
        if (!current && billingMutationKey) return; // An identical retry already completed.
        if (!current || !current.isOpen) notFound("Open membership not found.");
        current.billingMutation = null;
        current.cancellation = {
          reason: input.reason as any,
          comment: input.comment ?? "",
          requestedBy: toObjectId(actorId),
          requestedAt: now,
          source,
        } as any;
        if (periodEnd && current.currentPeriodEnd && current.currentPeriodEnd > now) {
          actuallyScheduled = true;
          current.status = MEMBERSHIP_STATUS.CANCEL_SCHEDULED;
          current.cancelAtPeriodEnd = true;
          current.cancelScheduledAt = now;
          current.autoRenew = false;
          current.isOpen = true;
        } else {
          await terminalizeMembership({
            tenantId,
            membership: current,
            status: MEMBERSHIP_STATUS.CANCELLED,
            reason: "membership_cancelled",
            idempotencyPrefix: `membership-cancelled:${current._id}`,
            session,
            occurredAt: now,
          });
        }
        if (actuallyScheduled) await current.save({ session });
        await recordMembershipAudit({ tenantId, actorId, userId: String(current.user), membershipId, planId: String(current.plan), type: actuallyScheduled ? "membership.cancellation_scheduled" : "membership.cancelled", source, metadata: { reason: input.reason, comment: input.comment ?? "" }, session });
        await enqueueMembershipNotification({
          tenantId,
          userId: String(current.user),
          membershipId,
          type: actuallyScheduled ? "cancellation_scheduled" : "cancelled",
          intentKey: `membership:${membershipId}:${actuallyScheduled ? "cancellation-scheduled" : "cancelled"}:${now.getTime()}`,
          session,
        });
      });
    } finally {
      await session.endSession();
    }
    const updatedMembership = await membershipRepository.findUserMembershipById(tenantId, membershipId);
    if (!updatedMembership) notFound("Membership not found.");
    return serializeMembership(updatedMembership, await balancesFor(updatedMembership._id));
  },

  async resume(tenantId: string, userId: string) {
    let membership = await membershipRepository.findOpenUserMembership(tenantId, userId, { includeStripe: true });
    if (!membership || membership.status !== MEMBERSHIP_STATUS.CANCEL_SCHEDULED && !membership.billingMutation?.startsWith("resume:")) {
      conflict({ message: "Membership does not have a scheduled cancellation.", code: "MEMBERSHIP_CANCELLATION_NOT_SCHEDULED" });
    }
    const stripe = (membership as any).stripe;
    let billingMutationKey: string | null = null;
    if (stripe?.subscriptionId) {
      if (!stripe.connectedAccountId) throw new Error("Membership subscription is missing its connected account.");
      const mutationKey = await claimMembershipBillingMutation(membership, "resume", {});
      billingMutationKey = mutationKey;
      await updateMembershipSubscriptionCancellation(
        stripe.connectedAccountId,
        stripe.subscriptionId,
        false,
        `membership-resume-${membership._id}-${mutationKey}`,
      );
    }
    const resumedAt = new Date();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await UserMembershipModel.findOne({
          _id: membership._id,
          tenant: toObjectId(tenantId),
          user: toObjectId(userId),
          ...(!billingMutationKey ? { status: MEMBERSHIP_STATUS.CANCEL_SCHEDULED } : {}),
          isOpen: true,
          ...(billingMutationKey ? { billingMutation: billingMutationKey } : {}),
        }).select("+stripe.subscriptionId").session(session).exec();
        if (!current) {
          if (billingMutationKey) return; // An identical retry already completed.
          conflict({ message: "Membership does not have a scheduled cancellation.", code: "MEMBERSHIP_CANCELLATION_NOT_SCHEDULED" });
        }
        current.status = MEMBERSHIP_STATUS.ACTIVE;
        current.billingMutation = null;
        current.cancelAtPeriodEnd = false;
        current.cancelScheduledAt = null;
        current.cancellation = undefined as any;
        current.autoRenew = Boolean((current as any).stripe?.subscriptionId) &&
          current.planSnapshot.billing.type === "recurring";
        await current.save({ session });
        await recordMembershipAudit({ tenantId, actorId: userId, userId, membershipId: String(current._id), planId: String(current.plan), type: "membership.cancellation_resumed", source: "customer", session });
        await enqueueMembershipNotification({
          tenantId,
          userId,
          membershipId: String(current._id),
          type: "resumed",
          intentKey: `membership:${current._id}:resumed:${resumedAt.getTime()}`,
          session,
        });
        membership = current;
      });
    } finally {
      await session.endSession();
    }
    return serializeMembership(membership, await balancesFor(membership._id));
  },

  async ledger(tenantId: string, userId: string) {
    const membership = await membershipRepository.findOpenUserMembership(tenantId, userId) ??
      await UserMembershipModel.findOne({ tenant: toObjectId(tenantId), user: toObjectId(userId) })
        .sort({ createdAt: -1 }).exec();
    if (!membership) return { entries: [], balances: [] };
    const [entries, balances] = await Promise.all([
      MembershipEntitlementLedgerModel.find({ tenant: toObjectId(tenantId), user: toObjectId(userId), membership: membership._id })
        .sort({ createdAt: -1, sequence: -1 }).limit(500).lean().exec(),
      balancesFor(membership._id),
    ]);
    return {
      entries: entries.map(serializeLedgerEntry),
      balances: balances.map((balance: any) => ({
        benefitKey: balance.benefitKey,
        granted: balance.granted,
        redeemed: balance.redeemed,
        adjusted: balance.adjusted,
        expired: balance.expired,
        available: balance.available,
        expiresAt: balance.expiresAt?.toISOString?.() ?? null,
        updatedAt: balance.updatedAt?.toISOString?.() ?? null,
      })),
    };
  },

  async invoices(tenantId: string, userId: string, page = 1, limit = 25) {
    const query = { tenant: toObjectId(tenantId), user: toObjectId(userId) };
    const [invoices, total] = await Promise.all([
      MembershipInvoiceModel.find(query)
        .sort({ issuedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      MembershipInvoiceModel.countDocuments(query).exec(),
    ]);
    return {
      invoices: invoices.map(serializeMembershipInvoice),
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  },

  async invoice(tenantId: string, userId: string, invoiceId: string) {
    const invoice = await MembershipInvoiceModel.findOne({
      _id: toObjectId(invoiceId), tenant: toObjectId(tenantId), user: toObjectId(userId),
    }).lean().exec();
    if (!invoice) notFound("Membership invoice not found.");
    return serializeMembershipInvoice(invoice);
  },

  async invoiceDocumentUrl(tenantId: string, userId: string, invoiceId: string) {
    const invoice = await MembershipInvoiceModel.findOne({
      _id: toObjectId(invoiceId), tenant: toObjectId(tenantId), user: toObjectId(userId),
    }).select("+invoicePdfUrl +hostedInvoiceUrl").exec();
    if (!invoice) notFound("Membership invoice not found.");
    const value = (invoice as any).invoicePdfUrl || (invoice as any).hostedInvoiceUrl;
    if (!value) notFound("Membership invoice document is not available.");
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !(
        url.hostname === "stripe.com" ||
        url.hostname.endsWith(".stripe.com") ||
        url.hostname.endsWith(".stripeusercontent.com")
      )) throw new Error("unsafe");
      return url.toString();
    } catch {
      notFound("Membership invoice document is not available.");
    }
  },

  async expireOverdue(tenantId?: string) {
    const now = new Date();
    return UserMembershipModel.updateMany(
      {
        ...(tenantId ? { tenant: toObjectId(tenantId) } : {}),
        status: { $in: [MEMBERSHIP_STATUS.ACTIVE, MEMBERSHIP_STATUS.CANCEL_SCHEDULED] },
        currentPeriodEnd: { $lte: now },
        $or: [{ autoRenew: false }, { "planSnapshot.billing.type": "fixed" }],
      },
      { $set: { status: MEMBERSHIP_STATUS.EXPIRED, isOpen: false, cancelAtPeriodEnd: false } },
    ).exec();
  },
};

export { assertSnapshotScope, periodEndFromBilling };

