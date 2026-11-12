import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  expire: vi.fn(),
  attach: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    checkout: {
      sessions: {
        create: mocks.create,
        retrieve: mocks.retrieve,
        expire: mocks.expire,
      },
    },
  }),
  getConnectedAccountRequestOptions: (stripeAccount: string, extra = {}) => ({
    stripeAccount,
    ...extra,
  }),
}));
vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    attachStripeSession: mocks.attach,
    releaseExpiredStripeOrder: mocks.release,
  },
}));
import Order from "@/modules/order/order.model.js";
import {
  cancelVoucherCheckout,
  recoverVoucherStripeSession,
} from "@/modules/checkout/services/checkout.voucher-session.service.js";
const tenantId = "64b000000000000000000001",
  orderId = "64b000000000000000000002",
  userId = "64b000000000000000000003";
const order = (changes: any = {}) => ({
  _id: orderId,
  tenant: tenantId,
  createdBy: userId,
  createdAt: new Date(),
  currency: "CZK",
  expectedAmountMinor: 2500,
  isPaid: false,
  status: "pending_order",
  voucherRedemptions: [{}],
  stripe: {
    sessionId: "cs_voucher",
    connectedAccountId: "acct_tenant",
    livemode: false,
  },
  ...changes,
});
const stripeSession = (changes: any = {}) => ({
  id: "cs_voucher",
  status: "open",
  payment_status: "unpaid",
  currency: "czk",
  amount_total: 2500,
  client_reference_id: orderId,
  metadata: { tenantId },
  livemode: false,
  ...changes,
});
function findOrder(value: any) {
  const query = {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(value),
  };
  return vi.spyOn(Order, "findOne").mockReturnValue(query as any);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.attach.mockResolvedValue({ modifiedCount: 1 });
  mocks.release.mockResolvedValue(true);
  mocks.retrieve.mockResolvedValue(stripeSession());
});
afterEach(() => vi.restoreAllMocks());
describe("voucher payment recovery and cancellation", () => {
  it("requires ownership and uses the saved connected account to expire first", async () => {
    const find = findOrder(order());
    mocks.expire.mockResolvedValue(stripeSession({ status: "expired" }));
    await expect(
      cancelVoucherCheckout({ tenantId, userId, orderId }),
    ).resolves.toMatchObject({ voucherReleased: true });
    expect(find).toHaveBeenCalledWith({
      _id: orderId,
      tenant: tenantId,
      createdBy: userId,
      "voucherRedemptions.0": { $exists: true },
    });
    expect(mocks.expire).toHaveBeenCalledWith("cs_voucher", {
      stripeAccount: "acct_tenant",
    });
    expect(mocks.expire.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.release.mock.invocationCallOrder[0],
    );
  });
  it("never releases a payment that completed while the customer returned to cancel", async () => {
    findOrder(order());
    mocks.retrieve.mockResolvedValue(
      stripeSession({ status: "complete", payment_status: "paid" }),
    );
    await expect(
      cancelVoucherCheckout({ tenantId, userId, orderId }),
    ).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_PENDING" });
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("keeps holds if Stripe expiration fails ambiguously", async () => {
    findOrder(order());
    mocks.expire.mockRejectedValue(new Error("Network interrupted"));
    await expect(
      cancelVoucherCheckout({ tenantId, userId, orderId }),
    ).rejects.toThrow("Network interrupted");
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("rejects a different owner or tenant without asking Stripe", async () => {
    findOrder(null);
    await expect(
      cancelVoucherCheckout({ tenantId, userId, orderId }),
    ).rejects.toMatchObject({ code: "VOUCHER_ORDER_NOT_FOUND" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("returns a stable result after the same cancellation was already completed", async () => {
    findOrder(
      order({
        status: "cancelled_order",
        voucherCheckoutReleasedAt: new Date(),
      }),
    );
    await expect(
      cancelVoucherCheckout({ tenantId, userId, orderId }),
    ).resolves.toMatchObject({ voucherReleased: true });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it.each([
    { amount_total: 9999 },
    { currency: "eur" },
    { client_reference_id: "other-order" },
    { metadata: { tenantId: "other-tenant" } },
    { livemode: true },
  ])(
    "rejects provider identity mismatch %j before release",
    async (changes) => {
      findOrder(order());
      mocks.retrieve.mockResolvedValue(stripeSession(changes));
      await expect(
        cancelVoucherCheckout({ tenantId, userId, orderId }),
      ).rejects.toThrow("does not match");
      expect(mocks.expire).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
    },
  );
  it("reuses the original create payload/key and then retrieves current state", async () => {
    const payload = { expires_at: 123456, line_items: [{ quantity: 1 }] };
    const pending = order({
      stripe: {
        sessionId: "",
        connectedAccountId: "acct_tenant",
        livemode: null,
      },
      voucherStripeRequest: payload,
    });
    mocks.create.mockResolvedValue(stripeSession());
    mocks.retrieve.mockResolvedValue(stripeSession({ status: "expired" }));
    await expect(
      recoverVoucherStripeSession(tenantId, pending),
    ).resolves.toMatchObject({ status: "expired" });
    expect(mocks.create).toHaveBeenCalledWith(payload, {
      stripeAccount: "acct_tenant",
      idempotencyKey: `checkout-session:${orderId}`,
    });
    expect(mocks.retrieve).toHaveBeenCalledWith("cs_voucher", {
      stripeAccount: "acct_tenant",
    });
    expect(mocks.attach).toHaveBeenCalledOnce();
  });
  it("does not recreate an uncertain payment after the safe idempotency window", async () => {
    const pending = order({
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      stripe: {
        sessionId: "",
        connectedAccountId: "acct_tenant",
        livemode: null,
      },
      voucherStripeRequest: {},
    });
    await expect(
      recoverVoucherStripeSession(tenantId, pending),
    ).rejects.toMatchObject({ code: "VOUCHER_PAYMENT_REVIEW_REQUIRED" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
