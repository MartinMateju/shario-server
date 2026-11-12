import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncInvoice: vi.fn(),
  applyPayment: vi.fn(),
  updateMembership: vi.fn(),
}));

vi.mock(
  "@/modules/membership/services/membership-invoice.service.js",
  () => ({ syncMembershipInvoice: mocks.syncInvoice }),
);

vi.mock(
  "@/modules/membership/services/membership-webhook.service.js",
  () => ({ applyPaymentConfirmed: mocks.applyPayment }),
);

vi.mock(
  "@/modules/membership/user-membership.model.js",
  () => ({ default: { updateOne: mocks.updateMembership } }),
);

import { recoverMembershipCheckout } from "@/modules/membership/services/membership-checkout-recovery.service.js";

describe("membership Checkout recovery invoice persistence", () => {
  beforeEach(() => {
    mocks.syncInvoice.mockReset().mockResolvedValue({
      id: "in_fixed_123",
      status_transitions: { paid_at: 1_721_736_100 },
    });
    mocks.applyPayment.mockReset().mockResolvedValue(undefined);
    mocks.updateMembership.mockReset();
  });

  it("syncs a fixed paid Checkout invoice before activating from its paid timestamp", async () => {
    const membership = {
      _id: "membership_123",
      tenant: "tenant_123",
      user: "user_123",
      status: "pending",
      planSnapshot: { billing: { type: "fixed", durationDays: 30 } },
    };
    const checkout = {
      id: "cs_fixed_123",
      created: 1_721_736_000,
      payment_status: "paid",
      status: "complete",
      invoice: "in_fixed_123",
      payment_intent: null,
    } as any;

    const result = await recoverMembershipCheckout({
      membership,
      checkout,
      connectedAccountId: "acct_tenant_123",
    });

    expect(result).toBe("activated");
    expect(mocks.syncInvoice).toHaveBeenCalledWith(expect.objectContaining({
      membership,
      connectedAccountId: "acct_tenant_123",
      invoice: "in_fixed_123",
      source: expect.objectContaining({ id: "recover:checkout-invoice:cs_fixed_123" }),
    }));
    expect(mocks.applyPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "recover:checkout:cs_fixed_123",
        created: 1_721_736_100,
      }),
      membership,
      "acct_tenant_123",
      expect.objectContaining({ id: "in_fixed_123" }),
    );
    expect(mocks.syncInvoice.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.applyPayment.mock.invocationCallOrder[0]);
  });

  it("syncs the expanded latest subscription invoice before recurring activation", async () => {
    const membership = {
      _id: "membership_recurring",
      tenant: "tenant_123",
      user: "user_123",
      status: "pending",
      planSnapshot: { billing: { type: "recurring", interval: "month", intervalCount: 1 } },
    };
    const invoice = { id: "in_subscription_latest", status_transitions: { paid_at: 1_721_736_200 } };
    const checkout = {
      id: "cs_recurring_123",
      created: 1_721_736_000,
      payment_status: "paid",
      status: "complete",
      invoice: null,
      payment_intent: null,
      subscription: { id: "sub_123", status: "active", latest_invoice: invoice },
    } as any;

    await recoverMembershipCheckout({
      membership,
      checkout,
      connectedAccountId: "acct_tenant_123",
    });

    expect(mocks.syncInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoice }));
    expect(mocks.syncInvoice.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.applyPayment.mock.invocationCallOrder[0]);
  });
});
