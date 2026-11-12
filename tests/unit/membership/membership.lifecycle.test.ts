import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expireEntitlements: vi.fn(),
}));

vi.mock(
  "@/modules/membership/services/membership-entitlement.service.js",
  () => ({ expireMembershipEntitlements: mocks.expireEntitlements }),
);

import { terminalizeMembership } from "@/modules/membership/services/membership-lifecycle.service.js";

describe("membership terminal lifecycle", () => {
  beforeEach(() => {
    mocks.expireEntitlements.mockReset().mockResolvedValue(undefined);
  });

  it("expires benefits and closes cancellation state in the same session", async () => {
    const session = { id: "transaction-session" } as any;
    const membership = {
      status: "active",
      isOpen: true,
      autoRenew: true,
      cancelAtPeriodEnd: true,
      cancelScheduledAt: new Date("2026-08-01T00:00:00.000Z"),
      cancelledAt: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const occurredAt = new Date("2026-07-23T12:00:00.000Z");

    await terminalizeMembership({
      tenantId: "tenant-1",
      membership,
      status: "cancelled",
      reason: "stripe_subscription_cancelled",
      idempotencyPrefix: "stripe-subscription-cancelled:sub_1",
      session,
      occurredAt,
    });

    expect(mocks.expireEntitlements).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      membership,
      reason: "stripe_subscription_cancelled",
      idempotencyPrefix: "stripe-subscription-cancelled:sub_1",
      session,
    });
    expect(membership).toMatchObject({
      status: "cancelled",
      isOpen: false,
      autoRenew: false,
      cancelAtPeriodEnd: false,
      cancelScheduledAt: null,
      cancelledAt: occurredAt,
    });
    expect(membership.save).toHaveBeenCalledWith({ session });
  });
});
