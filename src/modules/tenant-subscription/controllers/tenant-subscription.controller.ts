import type { Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { deriveEffectiveTenantModules } from "@/modules/tenants/tenant-workspace-modules.js";
import {
  getResolvedWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import {
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { isPlatformBillingCurrency } from "@/shared/money/currency.js";

import {
  ensureTenantSubscription,
  getTenantSubscriptionAccess,
} from "../services/tenant-subscription.service.js";
import {
  cancelTenantSubscription,
  changeTenantPlan,
  createTenantCheckout,
  createTenantPortalSession,
  getSubscriptionPlanCatalog,
  getTenantPaymentMethodSummary,
  listTenantInvoices,
  previewTenantPlanChange,
  resumeTenantSubscription,
} from "../services/tenant-subscription.stripe.service.js";
import {
  cancelSubscriptionSchema,
  checkoutSchema,
  invoiceListSchema,
  planChangeSchema,
  portalSchema,
  validateSubscriptionBody,
} from "../tenant-subscription.validators.js";
import {
  PLATFORM_SUBSCRIPTION_CURRENCIES,
  PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY,
} from "../tenant-subscription.catalog.js";

const serializeSubscription = (
  subscription: Awaited<ReturnType<typeof ensureTenantSubscription>>,
) => ({
  id: String(subscription._id),
  status: subscription.status,
  trialPlan: subscription.trialPlan,
  trialPlanVersion: subscription.trialPlanVersion,
  billingPlan: subscription.billingPlan ?? null,
  planVersion: subscription.planVersion ?? null,
  billingInterval: subscription.billingInterval ?? null,
  billingCurrency: subscription.billingCurrency ?? null,
  trialStartedAt: subscription.trialStartedAt ?? null,
  trialEndsAt: subscription.trialEndsAt ?? null,
  currentPeriodStart: subscription.currentPeriodStart ?? null,
  currentPeriodEnd: subscription.currentPeriodEnd ?? null,
  graceEndsAt: subscription.graceEndsAt ?? null,
  cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
  canceledAt: subscription.canceledAt ?? null,
  endedAt: subscription.endedAt ?? null,
  pendingChange: subscription.pendingChange
    ? {
        plan: subscription.pendingChange.plan,
        planVersion: subscription.pendingChange.planVersion,
        billingInterval: subscription.pendingChange.billingInterval,
        effectiveAt: subscription.pendingChange.effectiveAt,
      }
    : null,
  latestInvoiceId: subscription.latestInvoiceId ?? null,
  lastPaymentFailedAt: subscription.lastPaymentFailedAt ?? null,
  paymentRetryCount: subscription.paymentRetryCount ?? 0,
  nextPaymentAttemptAt: subscription.nextPaymentAttemptAt ?? null,
  paymentRecoveryUrl: subscription.paymentRecoveryUrl ?? null,
  paymentFailureReason: subscription.paymentFailureReason ?? null,
  hasPaymentProfile: Boolean(subscription.stripe?.customerId),
  hasStripeSubscription: Boolean(subscription.stripe?.subscriptionId),
});

export const getCurrentTenantSubscription = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const [{ tenant, subscription, access }, plans] = await Promise.all([
      getTenantSubscriptionAccess(tenantId),
      getSubscriptionPlanCatalog(),
    ]);
    const paymentMethod = await getTenantPaymentMethodSummary(subscription);
    const effectiveModules = deriveEffectiveTenantModules({
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      workspaceModules: tenant.workspaceModules,
      legacyModules: tenant.modules,
    });

    res.status(200).json({
      tenant: {
        id: String(tenant._id),
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        plan: tenant.plan,
        planVersion: tenant.planVersion,
        currency: tenant.settings.currency,
        modules: effectiveModules,
        limits: tenant.limits,
      },
      subscription: serializeSubscription(subscription),
      paymentMethod,
      access,
      plans,
      billingCurrencies: PLATFORM_SUBSCRIPTION_CURRENCIES,
      defaultBillingCurrency: PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY,
      permissions: {
        canManageBilling: hasWorkspacePermission(
          getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
          WORKSPACE_PERMISSION.SUBSCRIPTION_MANAGE,
        ),
      },
    });
  },
);

export const startCurrentTenantCheckout = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = validateSubscriptionBody(checkoutSchema, req.body);
    const [tenant, subscription] = await Promise.all([
      getTenantOrThrow(tenantId),
      ensureTenantSubscription(tenantId),
    ]);
    const result = await createTenantCheckout({
      tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      ownerEmail: req.userInfo?.email ?? "",
      subscription,
      plan: input.plan,
      billingInterval: input.billingInterval,
      billingCurrency: input.billingCurrency ?? subscription.billingCurrency ??
        (isPlatformBillingCurrency(tenant.settings.currency)
          ? tenant.settings.currency
          : PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY),
      locale: input.locale,
    });

    res.status(200).json(result);
  },
);

export const previewCurrentTenantPlanChange = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = validateSubscriptionBody(planChangeSchema, req.body);
    const subscription = await ensureTenantSubscription(tenantId);
    const preview = await previewTenantPlanChange({
      subscription,
      plan: input.plan,
      billingInterval: input.billingInterval,
      billingCurrency: input.billingCurrency,
    });

    res.status(200).json(preview);
  },
);

export const changeCurrentTenantPlan = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = validateSubscriptionBody(planChangeSchema, req.body);
    const subscription = await ensureTenantSubscription(tenantId);
    const result = await changeTenantPlan({
      subscription,
      plan: input.plan,
      billingInterval: input.billingInterval,
      billingCurrency: input.billingCurrency,
    });

    res.status(200).json(result);
  },
);

export const cancelCurrentTenantSubscription = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = validateSubscriptionBody(cancelSubscriptionSchema, req.body);
    const subscription = await ensureTenantSubscription(tenantId);
    const result = await cancelTenantSubscription({ subscription, ...input });

    res.status(200).json(result);
  },
);

export const resumeCurrentTenantSubscription = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const subscription = await ensureTenantSubscription(tenantId);
    const result = await resumeTenantSubscription(subscription);

    res.status(200).json(result);
  },
);

export const listCurrentTenantInvoices = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const input = validateSubscriptionBody(invoiceListSchema, req.query);
    const subscription = await ensureTenantSubscription(tenantId);
    const result = await listTenantInvoices({ subscription, ...input });

    res.status(200).json(result);
  },
);

export const openCurrentTenantBillingPortal = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { locale, flow } = validateSubscriptionBody(portalSchema, req.body);
    const [tenant, subscription] = await Promise.all([
      getTenantOrThrow(tenantId),
      ensureTenantSubscription(tenantId),
    ]);
    const url = await createTenantPortalSession({
      subscription,
      tenantSlug: tenant.slug,
      locale,
      flow,
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ url });
  },
);
