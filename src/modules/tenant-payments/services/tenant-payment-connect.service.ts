import { CONNECT_ACCOUNT_AUTOMATIC_RETRY_WINDOW_MS, STRIPE_FULL_DASHBOARD_URL, TENANT_PAYMENT_DASHBOARD_TYPE, TENANT_PAYMENT_ONBOARDING_STATUS } from "../tenant-payment-account.constants.js";
import { ensureTenantPaymentAccountRecord, findTenantPaymentAccountByTenant, markTenantPaymentProvisioningStarted, markTenantPaymentSyncFailed, resetTenantPaymentProvisioningAttempt, updateTenantPaymentAccountSnapshot } from "../tenant-payment-account.repository.js";
import { logger } from "@/config/logger.js";
import { conflict, internalServerError } from "@/shared/http/httpErrors.js";
import { randomUUID } from "node:crypto";

import type {
  ReadyTenantConnectedAccount,
  TenantPaymentAccountDocument,
  TenantPaymentAccountSummary,
} from "../tenant-payment-account.types.js";
import {
  createTenantConnectedAccount,
  createTenantConnectedAccountLink,
  retrieveTenantConnectedAccount,
  toTenantPaymentAccountSnapshot,
} from "../tenant-payment.stripe.gateway.js";
import { getTenantPaymentConnectUrls } from "../tenant-payment.urls.js";
import type { TenantPaymentConnectLocale, TenantPaymentConnectSetupStep } from "../tenant-payment.validators.js";

type StripeErrorLike = {
  type?: unknown;
  rawType?: unknown;
  code?: unknown;
  message?: unknown;
  requestId?: unknown;
  statusCode?: unknown;
};

const DEFINITIVE_ACCOUNT_CREATE_FAILURES = new Set([
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
]);

const emptyAccountSummary = (): TenantPaymentAccountSummary => ({
  connected: false,
  onboardingStatus: TENANT_PAYMENT_ONBOARDING_STATUS.NOT_STARTED,
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  country: null,
  defaultCurrency: null,
  dashboardType: null,
  lastSyncedAt: null,
});

const asStripeError = (error: unknown): StripeErrorLike => {
  if (!error || typeof error !== "object") {
    return {};
  }

  return error as StripeErrorLike;
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim()
    ? value.trim()
    : null;

const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : null;

const stripeErrorType = (error: unknown): string | null => {
  const stripeError = asStripeError(error);

  return (
    stringValue(stripeError.type) ??
    stringValue(stripeError.rawType)
  );
};

const stripeErrorCode = (
  error: unknown,
  fallback: string,
): string => {
  const stripeError = asStripeError(error);

  return (
    stringValue(stripeError.code) ??
    stringValue(stripeError.type) ??
    stringValue(stripeError.rawType) ??
    fallback
  ).slice(0, 100);
};

const stripeErrorMessage = (error: unknown): string | null =>
  stringValue(asStripeError(error).message);

const stripeRequestId = (error: unknown): string | null =>
  stringValue(asStripeError(error).requestId);

const stripeStatusCode = (error: unknown): number | null =>
  numberValue(asStripeError(error).statusCode);

const isDefinitiveAccountCreateFailure = (
  error: unknown,
): boolean => {
  const type = stripeErrorType(error);

  return type !== null &&
    DEFINITIVE_ACCOUNT_CREATE_FAILURES.has(type);
};

const isConnectPlatformNotConfigured = (
  error: unknown,
): boolean => {
  if (stripeErrorType(error) !== "StripeInvalidRequestError") {
    return false;
  }

  const message = stripeErrorMessage(error)?.toLowerCase() ?? "";

  return (
    message.includes("signed up for connect") ||
    message.includes("sign up for connect")
  );
};

const createAccountIdempotencyKey = (): string =>
  `shario-connect-account-${randomUUID()}`;

export const serializeTenantPaymentAccount = (
  account?: TenantPaymentAccountDocument | null,
): TenantPaymentAccountSummary => {
  if (!account?.stripeAccountId) {
    return emptyAccountSummary();
  }

  return {
    connected: true,
    onboardingStatus: account.onboardingStatus,
    detailsSubmitted: account.detailsSubmitted,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    country: account.country ?? null,
    defaultCurrency:
      account.defaultCurrency?.toUpperCase() ?? null,
    dashboardType:
      account.controller?.dashboardType ?? null,
    lastSyncedAt: account.lastSyncedAt ?? null,
  };
};

export const syncTenantPaymentAccount = async (
  account: TenantPaymentAccountDocument,
): Promise<TenantPaymentAccountDocument> => {
  if (!account.stripeAccountId) {
    return account;
  }

  try {
    const stripeAccount =
      await retrieveTenantConnectedAccount(
        account.stripeAccountId,
      );

    const updated =
      await updateTenantPaymentAccountSnapshot({
        tenantId: String(account.tenant),
        snapshot:
          toTenantPaymentAccountSnapshot(stripeAccount),
      });

    if (!updated) {
      internalServerError({
        message:
          "The connected account could not be synchronized.",
        code: "TENANT_PAYMENT_ACCOUNT_SYNC_CONFLICT",
      });
    }

    return updated;
  } catch (error) {
    await markTenantPaymentSyncFailed({
      tenantId: String(account.tenant),
      code: stripeErrorCode(
        error,
        "STRIPE_ACCOUNT_SYNC_FAILED",
      ),
    });

    throw error;
  }
};

export const getTenantPaymentConnectStatus = async (
  tenantId: string,
): Promise<TenantPaymentAccountSummary> => {
  const account =
    await findTenantPaymentAccountByTenant(tenantId);

  if (!account?.stripeAccountId) {
    return emptyAccountSummary();
  }

  return serializeTenantPaymentAccount(
    await syncTenantPaymentAccount(account),
  );
};

const requireProvisionableRecord = async (
  tenantId: string,
): Promise<TenantPaymentAccountDocument> => {
  let record =
    await ensureTenantPaymentAccountRecord(tenantId);

  if (record.stripeAccountId) {
    return record;
  }

  if (record.provisioningStartedAt) {
    const age =
      Date.now() -
      record.provisioningStartedAt.getTime();

    if (age > CONNECT_ACCOUNT_AUTOMATIC_RETRY_WINDOW_MS) {
      conflict({
        message:
          "Connected account setup needs review before it can be retried.",
        code:
          "TENANT_PAYMENT_ACCOUNT_PROVISIONING_REVIEW_REQUIRED",
      });
    }

    return record;
  }

  const claimed =
    await markTenantPaymentProvisioningStarted(
      tenantId,
      new Date(),
      createAccountIdempotencyKey(),
    );

  if (claimed) {
    return claimed;
  }

  /*
   * Another request might have claimed or completed provisioning
   * between ensureTenantPaymentAccountRecord() and the claim.
   * Re-read the authoritative state.
   */
  record =
    await ensureTenantPaymentAccountRecord(tenantId);

  if (
    !record.stripeAccountId &&
    !record.provisioningStartedAt
  ) {
    internalServerError({
      message:
        "Connected account provisioning could not be claimed.",
      code:
        "TENANT_PAYMENT_ACCOUNT_PROVISIONING_CLAIM_FAILED",
    });
  }

  return record;
};

const resetDefinitivelyFailedProvisioning = async ({
  tenantId,
  record,
  error,
}: {
  tenantId: string;
  record: TenantPaymentAccountDocument;
  error: unknown;
}): Promise<void> => {
  if (
    !record.provisioningStartedAt ||
    !record.accountCreateIdempotencyKey
  ) {
    logger.error(
      {
        tenantId,
        stripeErrorType: stripeErrorType(error),
        stripeRequestId: stripeRequestId(error),
      },
      "A definitive Stripe failure occurred without a complete provisioning claim.",
    );

    return;
  }

  try {
    const reset =
      await resetTenantPaymentProvisioningAttempt({
        tenantId,
        expectedProvisioningStartedAt:
          record.provisioningStartedAt,
        expectedAccountCreateIdempotencyKey:
          record.accountCreateIdempotencyKey,
        nextAccountCreateIdempotencyKey:
          createAccountIdempotencyKey(),
      });

    if (!reset) {
      logger.error(
        {
          tenantId,
          stripeErrorType: stripeErrorType(error),
          stripeRequestId: stripeRequestId(error),
        },
        "The failed Stripe provisioning claim could not be reset because its state changed.",
      );
    }
  } catch (resetError) {
    /*
     * Do not hide the original Stripe error. Leaving the claim in
     * place is deliberately fail-closed and prevents duplicates.
     */
    logger.error(
      {
        tenantId,
        stripeErrorType: stripeErrorType(error),
        stripeRequestId: stripeRequestId(error),
        resetError,
      },
      "The failed Stripe provisioning claim could not be reset.",
    );
  }
};

const ensureStripeAccount = async ({
  tenantId,
  tenantName,
  ownerEmail,
}: {
  tenantId: string;
  tenantName: string;
  ownerEmail?: string;
}): Promise<TenantPaymentAccountDocument> => {
  const record =
    await requireProvisionableRecord(tenantId);

  if (record.stripeAccountId) {
    return syncTenantPaymentAccount(record);
  }

  if (
    !record.provisioningStartedAt ||
    !record.accountCreateIdempotencyKey
  ) {
    internalServerError({
      message:
        "The connected account provisioning claim is incomplete.",
      code:
        "TENANT_PAYMENT_ACCOUNT_PROVISIONING_STATE_INVALID",
    });
  }

  let stripeAccount;

  try {
    stripeAccount =
      await createTenantConnectedAccount({
        tenantId,
        tenantName,
        ownerEmail,
        idempotencyKey:
          record.accountCreateIdempotencyKey,
      });
  } catch (error) {
    const definitive =
      isDefinitiveAccountCreateFailure(error);

    logger[definitive ? "warn" : "error"](
      {
        tenantId,
        definitive,
        stripeErrorType: stripeErrorType(error),
        stripeErrorCode: stripeErrorCode(
          error,
          "STRIPE_ACCOUNT_CREATE_FAILED",
        ),
        stripeStatusCode: stripeStatusCode(error),
        stripeRequestId: stripeRequestId(error),
      },
      definitive
        ? "Stripe definitively rejected connected account creation."
        : "Stripe connected account creation has an indeterminate outcome.",
    );

    if (definitive) {
      await resetDefinitivelyFailedProvisioning({
        tenantId,
        record,
        error,
      });
    }

    if (isConnectPlatformNotConfigured(error)) {
      internalServerError({
        message:
          "Stripe Connect is not enabled for the platform account. Complete the Stripe Connect platform profile and retry.",
        code:
          "STRIPE_CONNECT_PLATFORM_NOT_CONFIGURED",
      });
    }

    /*
     * Connection errors, Stripe API errors and unknown errors are
     * intentionally left claimed. Their outcome can be indeterminate,
     * so automatically starting a fresh attempt could create a
     * duplicate connected account.
     */
    throw error;
  }

  const updated =
    await updateTenantPaymentAccountSnapshot({
      tenantId,
      snapshot:
        toTenantPaymentAccountSnapshot(stripeAccount),
    });

  if (!updated) {
    logger.error(
      {
        tenantId,
        stripeAccountId: stripeAccount.id,
      },
      "A Stripe connected account could not be attached to its tenant.",
    );

    /*
     * Do not clear provisioning here. Stripe successfully created an
     * account, so clearing the claim could create a duplicate.
     */
    internalServerError({
      message:
        "The connected account could not be saved.",
      code: "TENANT_PAYMENT_ACCOUNT_ATTACH_FAILED",
    });
  }

  return updated;
};

export const createTenantPaymentOnboarding = async ({
  tenantId,
  tenantName,
  tenantSlug,
  ownerEmail,
  locale,
  setupStep,
}: {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  ownerEmail?: string;
  locale: TenantPaymentConnectLocale;
  setupStep?: TenantPaymentConnectSetupStep;
}): Promise<{
  url: string;
  account: TenantPaymentAccountSummary;
}> => {
  const account = await ensureStripeAccount({
    tenantId,
    tenantName,
    ownerEmail,
  });

  if (!account.stripeAccountId) {
    internalServerError({
      message:
        "The connected account is missing its Stripe identifier.",
      code: "TENANT_PAYMENT_ACCOUNT_ID_MISSING",
    });
  }

  if (
    account.onboardingStatus ===
    TENANT_PAYMENT_ONBOARDING_STATUS.COMPLETE
  ) {
    conflict({
      message:
        "Stripe account onboarding is already complete.",
      code:
        "TENANT_PAYMENT_ACCOUNT_ALREADY_COMPLETE",
    });
  }

  const { refreshUrl, returnUrl } =
    getTenantPaymentConnectUrls({
      tenantSlug,
      locale,
      setupStep,
    });

  const link =
    await createTenantConnectedAccountLink({
      stripeAccountId: account.stripeAccountId,
      refreshUrl,
      returnUrl,
    });

  return {
    url: link.url,
    account:
      serializeTenantPaymentAccount(account),
  };
};

export const getTenantPaymentDashboardLink = async (
  tenantId: string,
): Promise<{
  url: string;
  dashboardType: "full";
  singleUse: false;
}> => {
  const record =
    await findTenantPaymentAccountByTenant(tenantId);

  if (!record?.stripeAccountId) {
    conflict({
      message: "Connect a Stripe account first.",
      code: "TENANT_PAYMENTS_NOT_CONNECTED",
    });
  }

  const account =
    await syncTenantPaymentAccount(record);

  if (!account.detailsSubmitted) {
    conflict({
      message:
        "Complete Stripe onboarding before opening the Dashboard.",
      code: "TENANT_PAYMENT_ONBOARDING_REQUIRED",
    });
  }

  return {
    url: STRIPE_FULL_DASHBOARD_URL,
    dashboardType:
      TENANT_PAYMENT_DASHBOARD_TYPE.FULL,
    singleUse: false,
  };
};

/**
 * Fail-closed readiness guard for direct-charge checkout
 * integrations.
 *
 * Checkout code must use the returned account ID as Stripe's
 * `stripeAccount` request option for every create, retrieve,
 * expire and refund operation.
 */
export const requireReadyTenantConnectedAccount = async (
  tenantId: string,
): Promise<ReadyTenantConnectedAccount> => {
  const record =
    await findTenantPaymentAccountByTenant(tenantId);

  if (!record?.stripeAccountId) {
    conflict({
      message:
        "Online payments are not connected for this workspace.",
      code: "TENANT_PAYMENTS_NOT_CONNECTED",
    });
  }

  const account =
    await syncTenantPaymentAccount(record);

  if (
    account.onboardingStatus !==
    TENANT_PAYMENT_ONBOARDING_STATUS.COMPLETE ||
    !account.detailsSubmitted ||
    !account.chargesEnabled ||
    !account.payoutsEnabled
  ) {
    conflict({
      message:
        "Online payments are not ready for this workspace.",
      code: "TENANT_PAYMENTS_NOT_READY",
      details: {
        onboardingStatus:
          account.onboardingStatus,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
      },
    });
  }

  return {
    tenantId,
    stripeAccountId: account.stripeAccountId,
    country: account.country ?? null,
    defaultCurrency:
      account.defaultCurrency?.toUpperCase() ?? null,
  };
};

