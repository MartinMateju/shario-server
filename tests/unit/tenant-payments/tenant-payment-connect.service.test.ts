import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAccountLink: vi.fn(),
  ensureAccountRecord: vi.fn(),
  retrieveAccount: vi.fn(),
  toSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => ({
    ensureTenantPaymentAccountRecord: mocks.ensureAccountRecord,
    findTenantPaymentAccountByTenant: vi.fn(),
    markTenantPaymentProvisioningStarted: vi.fn(),
    markTenantPaymentSyncFailed: vi.fn(),
    resetTenantPaymentProvisioningAttempt: vi.fn(),
    updateTenantPaymentAccountSnapshot: mocks.updateSnapshot,
  }),
);

vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  createTenantConnectedAccount: vi.fn(),
  createTenantConnectedAccountLink: mocks.createAccountLink,
  retrieveTenantConnectedAccount: mocks.retrieveAccount,
  toTenantPaymentAccountSnapshot: mocks.toSnapshot,
}));

vi.mock("@/config/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { createTenantPaymentOnboarding } from "@/modules/tenant-payments/services/tenant-payment-connect.service.js";

const originalClientUrl = process.env.CLIENT_URL;

const connectedAccount = {
  tenant: "507f1f77bcf86cd799439011",
  stripeAccountId: "acct_launch_center",
  onboardingStatus: "pending",
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  country: "CZ",
  defaultCurrency: "czk",
  controller: { dashboardType: "full" },
  lastSyncedAt: new Date("2026-08-03T00:00:00.000Z"),
};

describe("tenant payment Launch Center return context", () => {
  beforeEach(() => {
    process.env.CLIENT_URL = "https://shario.io";
    mocks.ensureAccountRecord.mockResolvedValue(connectedAccount);
    mocks.retrieveAccount.mockResolvedValue({ id: "acct_launch_center" });
    mocks.toSnapshot.mockReturnValue({ stripeAccountId: "acct_launch_center" });
    mocks.updateSnapshot.mockResolvedValue(connectedAccount);
    mocks.createAccountLink.mockResolvedValue({
      url: "https://connect.stripe.example/onboarding",
    });
  });

  afterEach(() => {
    process.env.CLIENT_URL = originalClientUrl;
  });

  it("passes the allowlisted payment marker through to both Stripe URLs", async () => {
    await createTenantPaymentOnboarding({
      tenantId: "507f1f77bcf86cd799439011",
      tenantName: "Launch Studio",
      tenantSlug: "launch-studio",
      ownerEmail: "owner@example.com",
      locale: "en",
      setupStep: "payments",
    });

    expect(mocks.createAccountLink).toHaveBeenCalledWith({
      stripeAccountId: "acct_launch_center",
      refreshUrl:
        "https://launch-studio.shario.io/en/app/settings/payments?connect=refresh&setupStep=payments",
      returnUrl:
        "https://launch-studio.shario.io/en/app/settings/payments?connect=return&setupStep=payments",
    });
  });

  it("omits Launch Center context for ordinary Stripe onboarding", async () => {
    await createTenantPaymentOnboarding({
      tenantId: "507f1f77bcf86cd799439011",
      tenantName: "Launch Studio",
      tenantSlug: "launch-studio",
      locale: "cs",
    });

    expect(mocks.createAccountLink).toHaveBeenCalledWith({
      stripeAccountId: "acct_launch_center",
      refreshUrl:
        "https://launch-studio.shario.io/cs/app/settings/payments?connect=refresh",
      returnUrl:
        "https://launch-studio.shario.io/cs/app/settings/payments?connect=return",
    });
  });
});
