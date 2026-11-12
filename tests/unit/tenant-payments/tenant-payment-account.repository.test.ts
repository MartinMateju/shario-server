import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("@/modules/tenant-payments/tenant-payment-account.schema.js", () => ({
  default: {
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

import {
  markTenantPaymentProvisioningStarted,
  resetTenantPaymentProvisioningAttempt,
  updateTenantPaymentAccountSnapshot,
} from "@/modules/tenant-payments/tenant-payment-account.repository.js";

describe("tenant payment account provisioning repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOneAndUpdate.mockReturnValue({ exec: mocks.exec });
  });

  it("claims missing-or-null state and rotates the Stripe idempotency key", async () => {
    const startedAt = new Date("2026-07-24T08:00:00.000Z");
    mocks.exec.mockResolvedValue({ provisioningStartedAt: startedAt });

    await markTenantPaymentProvisioningStarted(
      "507f1f77bcf86cd799439011",
      startedAt,
      "shario-connect-account-fresh",
    );

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: "507f1f77bcf86cd799439011",
        stripeAccountId: null,
        provisioningStartedAt: null,
      },
      {
        $set: {
          provisioningStartedAt: startedAt,
          accountCreateIdempotencyKey: "shario-connect-account-fresh",
        },
      },
      { returnDocument: "after" },
    );
  });

  it("resets a definitive failure by rotating its key and unsetting its claim", async () => {
    const startedAt = new Date("2026-07-24T08:00:00.000Z");
    mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(
      resetTenantPaymentProvisioningAttempt({
        tenantId: "507f1f77bcf86cd799439011",
        expectedProvisioningStartedAt: startedAt,
        expectedAccountCreateIdempotencyKey: "shario-connect-account-old",
        nextAccountCreateIdempotencyKey: "shario-connect-account-next",
      }),
    ).resolves.toBe(true);

    expect(mocks.updateOne).toHaveBeenCalledWith(
      {
        tenant: "507f1f77bcf86cd799439011",
        stripeAccountId: null,
        provisioningStartedAt: startedAt,
        accountCreateIdempotencyKey: "shario-connect-account-old",
      },
      {
        $set: {
          accountCreateIdempotencyKey: "shario-connect-account-next",
        },
        $unset: {
          provisioningStartedAt: 1,
        },
      },
    );
  });

  it("clears the provisioning claim after the Stripe account is attached", async () => {
    const lastSyncedAt = new Date("2026-07-24T08:01:00.000Z");
    mocks.exec.mockResolvedValue({ stripeAccountId: "acct_test" });

    await updateTenantPaymentAccountSnapshot({
      tenantId: "507f1f77bcf86cd799439011",
      snapshot: {
        stripeAccountId: "acct_test",
        onboardingStatus: "pending",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        livemode: false,
        requirements: {
          currentlyDue: [],
          eventuallyDue: [],
          pastDue: [],
          pendingVerification: [],
        },
        lastSyncedAt,
      },
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      {
        tenant: "507f1f77bcf86cd799439011",
        $or: [{ stripeAccountId: null }, { stripeAccountId: "acct_test" }],
      },
      expect.objectContaining({
        $unset: expect.objectContaining({
          provisioningStartedAt: 1,
        }),
      }),
      { returnDocument: "after" },
    );
  });
});
