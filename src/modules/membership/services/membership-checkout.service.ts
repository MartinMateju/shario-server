import { createHash } from "node:crypto";
import mongoose from "mongoose";

import UserModel from "@/modules/user/user.model.js";
import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import { requireReadyTenantConnectedAccount } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";
import {
  buildTenantCommerceUrl,
  resolveTenantCommerceOrigin,
} from "@/modules/checkout/checkout.urls.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";
import MembershipPlanModel from "../membership-plan.model.js";
import MembershipPlanVersionModel from "../membership-plan-version.model.js";
import UserMembershipModel from "../user-membership.model.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import { membershipRepository } from "../membership.repository.js";
import {
  MEMBERSHIP_PLAN_STATUS,
  MEMBERSHIP_PLAN_VERSION_STATUS,
  MEMBERSHIP_STATUS,
} from "../membership.constants.js";
import {
  assertMembershipIdempotencyIdentity,
  membershipIdentityHash,
} from "../membership.idempotency.js";
import { serializeMembership } from "../membership.serializers.js";
import {
  createMembershipBillingPortalSession,
  createMembershipCheckoutSession,
  expireMembershipCheckoutSession,
  findMembershipCheckoutSession,
  retrieveMembershipCheckoutSession,
} from "../membership.stripe.gateway.js";
import type { z } from "zod";
import type { billingPortalSchema, checkoutSchema } from "../membership.validators.js";
import { membershipPlanSnapshot } from "./user-membership.service.js";
import { recoverMembershipCheckout } from "./membership-checkout-recovery.service.js";
import { toObjectId } from "../membership.utils.js";
import { membershipLocalizedText } from "../membership.localization.js";
import { resolveTenantLocaleSettings } from "@/modules/tenants/tenant-locale.js";

type CheckoutInput = z.infer<typeof checkoutSchema>;
type PortalInput = z.infer<typeof billingPortalSchema>;

export const membershipCheckoutUrls = (tenant: any, input: CheckoutInput) => {
  const origin = resolveTenantCommerceOrigin({ tenant, requestedOrigin: input.origin });
  const successBase = buildTenantCommerceUrl({
    origin,
    locale: input.locale,
    path: "memberships/checkout/success",
  });
  return {
    origin,
    successUrl: `${successBase}${successBase.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: buildTenantCommerceUrl({
      origin,
      locale: input.locale,
      path: "memberships/checkout/cancel",
      query: {
        checkout: "cancelled",
        ...(input.locationId ? { location: input.locationId } : {}),
      },
    }),
  };
};

export const membershipStripeIdempotencyKey = (
  tenantId: string,
  membershipId: string,
  key: string,
): string =>
  `membership-checkout-${tenantId}-${membershipId}-${createHash("sha256").update(key).digest("hex")}`;

const checkoutResponse = (membership: any, session: any) => ({
  membership: serializeMembership(membership),
  checkout: {
    sessionId: session.id,
    url: session.url ?? null,
    status: membership.status,
  },
});

export const membershipCheckoutService = {
  async create(
    tenantId: string,
    userId: string,
    input: CheckoutInput,
    idempotencyKey: string | undefined,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || key.length < 8 || key.length > 160) {
      conflict({ message: "A valid Idempotency-Key is required.", code: "MEMBERSHIP_IDEMPOTENCY_KEY_REQUIRED" });
    }
    const [tenant, user, account, plan] = await Promise.all([
      findTenantById(tenantId),
      UserModel.findOne({ _id: toObjectId(userId), tenant: toObjectId(tenantId) }).exec(),
      requireReadyTenantConnectedAccount(tenantId),
      MembershipPlanModel.findOne({
        _id: toObjectId(input.planId),
        tenant: toObjectId(tenantId),
        status: MEMBERSHIP_PLAN_STATUS.PUBLISHED,
      }).exec(),
    ]);
    if (!tenant) notFound("Workspace not found.");
    if (input.currency !== tenant.settings.currency) {
      conflict({ message: "Memberships use the studio's primary currency.", code: "MEMBERSHIP_PRIMARY_CURRENCY_REQUIRED" });
    }
    if (!user) notFound("User not found.");
    if (!plan?.currentPublishedVersion) notFound("Published membership plan not found.");
    const currentVersionId = String(plan.currentPublishedVersion);
    if (input.planVersionId && input.planVersionId !== currentVersionId) {
      conflict({ message: "The selected membership version is no longer available.", code: "MEMBERSHIP_VERSION_STALE" });
    }
    const version = await MembershipPlanVersionModel.findOne({
      _id: plan.currentPublishedVersion,
      tenant: toObjectId(tenantId),
      plan: plan._id,
      status: MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED,
    }).exec();
    if (!version) notFound("Published membership plan version not found.");
    let selectedLocation: ReturnType<typeof toObjectId> | null = null;
    if (version.locationScope.type === "selected") {
      if (!input.locationId || !version.locationScope.locationIds.map(String).includes(input.locationId)) {
        conflict({ message: "Select a location offered by this membership plan.", code: "MEMBERSHIP_LOCATION_REQUIRED" });
      }
      selectedLocation = toObjectId(input.locationId);
    } else if (input.locationId) {
      conflict({ message: "A location cannot be selected for an all-location membership.", code: "MEMBERSHIP_LOCATION_NOT_APPLICABLE" });
    }
    const price = version.prices.find((candidate: any) => candidate.currency === input.currency);
    if (!price) conflict({ message: "The membership is not offered in this currency.", code: "MEMBERSHIP_CURRENCY_NOT_OFFERED" });
    // Protect older records created before the positive-price invariant. Never
    // create a pending membership that Stripe could complete with
    // `no_payment_required`; complimentary access uses manual assignment.
    if (!Number.isSafeInteger(price.amountMinor) || price.amountMinor <= 0) {
      conflict({
        message: "Complimentary memberships must be assigned by the workspace owner.",
        code: "MEMBERSHIP_CHECKOUT_PRICE_REQUIRED",
      });
    }
    const urls = membershipCheckoutUrls(tenant, input);
    const identity = {
      operation: "membership.checkout.create",
      tenantId,
      userId,
      planId: input.planId,
      planVersionId: currentVersionId,
      currency: input.currency,
      locationId: input.locationId ?? null,
      locale: input.locale,
      origin: urls.origin,
      termsAccepted: input.termsAccepted,
    };
    const requestHash = membershipIdentityHash(identity);

    let membership = await UserMembershipModel.findOne({
      tenant: toObjectId(tenantId),
      "stripe.checkoutIdempotencyKey": key,
    }).select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt").exec();
    let terminalMembershipToReplace: any = null;
    if (membership) {
      assertMembershipIdempotencyIdentity((membership as any).stripe.checkoutRequestHash, requestHash);
      const stripe = (membership as any).stripe;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (!stripe.checkoutSessionId &&
          (!stripe.checkoutExpiresAt || stripe.checkoutExpiresAt <= nowSeconds + 30 * 60)) {
        // Legacy interrupted attempts have no persisted expiration. A delayed
        // new attempt can also be outside Stripe's minimum creation window.
        // Find the original remote Session before considering any replacement.
        const recovered = await findMembershipCheckoutSession({
          connectedAccountId: stripe.connectedAccountId,
          tenantId,
          membershipId: String(membership._id),
          createdAt: membership.createdAt,
        });
        if (recovered) {
          if (!membership.isOpen && recovered.status === "complete") {
            // Older reconciliation could close an unattached record without
            // discovering that its remote payment had already completed.
            conflict({ message: "An existing membership payment requires reconciliation before another checkout.", code: "MEMBERSHIP_CHECKOUT_RECOVERY_REQUIRED" });
          }
          membership = await UserMembershipModel.findOneAndUpdate({
            _id: membership._id,
            "stripe.checkoutIdempotencyKey": key,
            $or: [{ "stripe.checkoutSessionId": "" }, { "stripe.checkoutSessionId": { $exists: false } }],
          }, { $set: { "stripe.checkoutSessionId": recovered.id } }, { returnDocument: "after" })
            .select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt").exec()
            ?? await UserMembershipModel.findById(membership._id)
              .select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt").exec();
          if (!membership || (membership as any).stripe.checkoutSessionId !== recovered.id) {
            conflict({ message: "Membership payment recovery is still in progress.", code: "MEMBERSHIP_CHECKOUT_RECOVERY_REQUIRED" });
          }
        } else if (!membership.isOpen && stripe.checkoutExpiresAt && stripe.checkoutExpiresAt <= nowSeconds) {
          // A previously expired, fully discoverable attempt is safe to replace.
        } else if (stripe.checkoutExpiresAt && stripe.checkoutExpiresAt <= nowSeconds) {
          // The stored deadline has elapsed and no Session exists. An old
          // in-flight create can no longer produce a payable Checkout.
          const expired = await UserMembershipModel.findOneAndUpdate({
            _id: membership._id,
            status: MEMBERSHIP_STATUS.PENDING,
            "stripe.checkoutExpiresAt": stripe.checkoutExpiresAt,
            $or: [{ "stripe.checkoutSessionId": "" }, { "stripe.checkoutSessionId": { $exists: false } }],
          }, { $set: { status: MEMBERSHIP_STATUS.EXPIRED, isOpen: false, autoRenew: false } }, { returnDocument: "after" })
            .select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt").exec();
          if (!expired) conflict({ message: "Membership payment recovery is still in progress.", code: "MEMBERSHIP_CHECKOUT_RECOVERY_REQUIRED" });
          membership = expired;
        } else {
          conflict({ message: "Membership payment recovery is still in progress. Retry shortly or contact the workspace.", code: "MEMBERSHIP_CHECKOUT_RECOVERY_REQUIRED" });
        }
      }
      if ((membership as any).stripe.checkoutSessionId) {
        const existingSession = await retrieveMembershipCheckoutSession(
          (membership as any).stripe.connectedAccountId,
          (membership as any).stripe.checkoutSessionId,
        );
        if (membership.status === MEMBERSHIP_STATUS.PENDING) {
          await recoverMembershipCheckout({
            membership,
            checkout: existingSession,
            connectedAccountId: (membership as any).stripe.connectedAccountId,
          });
          membership = await UserMembershipModel.findById(membership._id)
            .select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt")
            .exec() ?? membership;
        }
        if (membership.isOpen) return checkoutResponse(membership, existingSession);
        // A locally closed pending Session must not remain payable after its
        // frontend idempotency key is released for a replacement attempt.
        if (existingSession.status === "open") {
          await expireMembershipCheckoutSession(
            (membership as any).stripe.connectedAccountId,
            existingSession.id,
          );
        }
      }
      if (membership.isOpen) {
        // A crash may leave a valid pending membership before Session attach;
        // reuse that membership and its membership-scoped Stripe key.
      } else {
        terminalMembershipToReplace = membership;
        membership = null;
      }
    }

    if (!membership) {
      const dbSession = await mongoose.startSession();
      try {
        await dbSession.withTransaction(async () => {
          if (terminalMembershipToReplace) {
            const released = await UserMembershipModel.updateOne(
              {
                _id: terminalMembershipToReplace._id,
                tenant: toObjectId(tenantId),
                isOpen: false,
                "stripe.checkoutIdempotencyKey": key,
              },
              { $set: { "stripe.checkoutIdempotencyKey": "" } },
              { session: dbSession },
            ).exec();
            if (released.modifiedCount !== 1) {
              conflict({
                message: "Membership checkout retry is already being replaced.",
                code: "MEMBERSHIP_CHECKOUT_REPLACEMENT_CONFLICT",
              });
            }
          }
          const existing = await membershipRepository.findOpenUserMembership(
            tenantId,
            userId,
            { session: dbSession },
          );
          if (existing) {
            conflict({ message: "User already has an open membership.", code: "MEMBERSHIP_ALREADY_OPEN" });
          }
          [membership] = await UserMembershipModel.create([{
            tenant: toObjectId(tenantId),
            user: toObjectId(userId),
            plan: plan._id,
            planVersion: version._id,
            planSnapshot: membershipPlanSnapshot(version),
            selectedLocation,
            currency: input.currency,
            amountMinor: price.amountMinor,
            status: MEMBERSHIP_STATUS.PENDING,
            isOpen: true,
            // The paid term starts only after Stripe confirms payment. Recurring
            // period boundaries come from the Subscription; fixed boundaries are
            // calculated from the first confirmed payment timestamp.
            currentPeriodStart: null,
            currentPeriodEnd: null,
            renewsAt: null,
            autoRenew: version.billing.type === "recurring",
            assignmentSource: "checkout",
            termsAcceptedAt: new Date(),
            termsAcceptedVersion: version.version,
            stripe: {
              connectedAccountId: account.stripeAccountId,
              checkoutIdempotencyKey: key,
              checkoutRequestHash: requestHash,
              // Persist before the external request, including its uncertain
              // outcome, so every retry sends identical Stripe parameters.
              checkoutExpiresAt: Math.floor(Date.now() / 1000) + 31 * 60,
            },
          }], { session: dbSession });
          await recordMembershipAudit({
            tenantId,
            actorId: userId,
            userId,
            membershipId: String(membership._id),
            planId: input.planId,
            type: "membership.checkout_started",
            source: "customer",
            metadata: {
              termsAcceptedAt: membership.termsAcceptedAt,
              termsAcceptedVersion: version.version,
              replacedMembershipId: terminalMembershipToReplace
                ? String(terminalMembershipToReplace._id)
                : null,
            },
            session: dbSession,
          });
        });
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
        const retry = await UserMembershipModel.findOne({
          tenant: toObjectId(tenantId),
          "stripe.checkoutIdempotencyKey": key,
        }).select("+stripe.connectedAccountId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.checkoutExpiresAt").exec();
        if (!retry?.isOpen) conflict({ message: "User already has an open membership.", code: "MEMBERSHIP_ALREADY_OPEN" });
        assertMembershipIdempotencyIdentity((retry as any).stripe.checkoutRequestHash, requestHash);
        membership = retry;
      } finally {
        await dbSession.endSession();
      }
    }

    const publicLanguages = resolveTenantLocaleSettings(tenant.settings);
    const checkoutLocale = publicLanguages.supportedPublicLanguages.includes(input.locale)
      ? input.locale : publicLanguages.publicDefaultLanguage;
    const session = await createMembershipCheckoutSession({
      connectedAccountId: account.stripeAccountId,
      idempotencyKey: membershipStripeIdempotencyKey(tenantId, String(membership._id), key),
      membershipId: String(membership._id),
      tenantId,
      userId,
      userEmail: user.email,
      planId: input.planId,
      planVersionId: currentVersionId,
      name: membershipLocalizedText(version, "name", checkoutLocale),
      description: membershipLocalizedText(version, "description", checkoutLocale),
      currency: input.currency,
      amountMinor: price.amountMinor,
      billing: version.billing,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      expiresAt: (membership as any).stripe.checkoutExpiresAt,
    });
    const attached = await UserMembershipModel.findOneAndUpdate(
      {
        _id: membership._id,
        status: MEMBERSHIP_STATUS.PENDING,
        $or: [
          { "stripe.checkoutSessionId": "" },
          { "stripe.checkoutSessionId": { $exists: false } },
        ],
      },
      { $set: { "stripe.checkoutSessionId": session.id } },
      { returnDocument: "after" },
    ).select("+stripe.connectedAccountId +stripe.checkoutSessionId").exec();
    if (!attached) {
      const current = await UserMembershipModel.findById(membership._id)
        .select("+stripe.connectedAccountId +stripe.checkoutSessionId")
        .exec();
      if (!current || (current as any).stripe.checkoutSessionId !== session.id) {
        await expireMembershipCheckoutSession(account.stripeAccountId, session.id).catch(() => undefined);
        conflict({ message: "Membership checkout could not be attached safely.", code: "MEMBERSHIP_CHECKOUT_ATTACH_CONFLICT" });
      }
      membership = current;
    } else {
      membership = attached;
    }
    return checkoutResponse(membership, session);
  },

  async status(tenantId: string, userId: string, sessionId: string) {
    let membership = await UserMembershipModel.findOne({
      tenant: toObjectId(tenantId),
      user: toObjectId(userId),
      "stripe.checkoutSessionId": sessionId,
    }).select("+stripe.connectedAccountId +stripe.checkoutSessionId").exec();
    if (!membership) notFound("Membership checkout not found.");
    const session = await retrieveMembershipCheckoutSession(
      (membership as any).stripe.connectedAccountId,
      sessionId,
    );
    if (membership.status === MEMBERSHIP_STATUS.PENDING) {
      await recoverMembershipCheckout({
        membership,
        checkout: session,
        connectedAccountId: (membership as any).stripe.connectedAccountId,
      });
      membership = await UserMembershipModel.findOne({
        _id: membership._id,
        tenant: toObjectId(tenantId),
        user: toObjectId(userId),
      }).exec() ?? membership;
    }
    return {
      membership: serializeMembership(membership),
      checkout: {
        sessionId,
        status: membership.status,
        paymentStatus: session.payment_status,
        sessionStatus: session.status,
      },
    };
  },

  async billingPortal(tenantId: string, userId: string, input: PortalInput) {
    let [membership, tenant] = await Promise.all([
      membershipRepository.findOpenUserMembership(tenantId, userId, { includeStripe: true }),
      findTenantById(tenantId),
    ]);
    if (!membership) {
      membership = await UserMembershipModel.findOne({
        tenant: toObjectId(tenantId), user: toObjectId(userId),
      }).sort({ createdAt: -1 })
        .select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId")
        .exec();
    }
    if (!membership || !tenant) notFound("Membership not found.");
    const stripe = (membership as any).stripe;
    if (!stripe?.connectedAccountId || !stripe?.customerId) {
      conflict({ message: "Billing portal is not available for this membership.", code: "MEMBERSHIP_BILLING_PORTAL_UNAVAILABLE" });
    }
    const origin = resolveTenantCommerceOrigin({ tenant, requestedOrigin: input.origin });
    const returnUrl = buildTenantCommerceUrl({ origin, locale: input.locale, path: "portal/membership" });
    const portal = await createMembershipBillingPortalSession({
      connectedAccountId: stripe.connectedAccountId,
      customerId: stripe.customerId,
      returnUrl,
    });
    return { url: portal.url };
  },
};

export default membershipCheckoutService;
