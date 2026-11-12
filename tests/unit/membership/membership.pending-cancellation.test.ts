import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(), subscription: vi.fn(), expire: vi.fn(), recover: vi.fn(), find: vi.fn(),
}));
vi.mock("@/modules/membership/membership.stripe.gateway.js", () => ({
  retrieveMembershipCheckoutSession: mocks.retrieve,
  retrieveMembershipSubscription: mocks.subscription,
  expireMembershipCheckoutSession: mocks.expire,
  cancelMembershipSubscription: vi.fn(),
  updateMembershipSubscriptionCancellation: vi.fn(),
}));
vi.mock("@/modules/membership/services/membership-checkout-recovery.service.js", () => ({
  recoverMembershipCheckout: mocks.recover,
}));
vi.mock("@/modules/membership/membership.repository.js", () => ({
  membershipRepository: { findUserMembershipById: mocks.find },
}));

import { prepareMembershipCancellation } from "@/modules/membership/services/user-membership.service.js";

const membership = () => ({
  _id: "507f1f77bcf86cd799439011", tenant: "507f1f77bcf86cd799439012",
  status: "pending", isOpen: true, currentPeriodStart: null, currentPeriodEnd: null,
  stripe: { connectedAccountId: "acct_member", checkoutSessionId: "cs_member" },
});
const paidCheckout = { id: "cs_member", status: "complete", payment_status: "paid", subscription: "sub_member" };

describe("pending membership cancellation payment safety", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.expire.mockResolvedValue(undefined);
    mocks.recover.mockResolvedValue("activated");
  });

  it("expires the still-payable Checkout before allowing local cancellation", async () => {
    const pending = membership();
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "open", payment_status: "unpaid" });
    await expect(prepareMembershipCancellation(pending)).resolves.toBe(pending);
    expect(mocks.expire).toHaveBeenCalledWith("acct_member", "cs_member");
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("does not close a membership when Stripe cannot confirm that Checkout stopped accepting payment", async () => {
    const failure = new Error("Stripe expiration unavailable");
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "open", payment_status: "unpaid" });
    mocks.expire.mockRejectedValue(failure);
    await expect(prepareMembershipCancellation(membership())).rejects.toBe(failure);
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers paid access before scheduling cancellation when completion races expiration: %s", async (raced) => {
    const pending = membership();
    const active = { ...pending, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000), stripe: { ...pending.stripe, subscriptionId: "sub_member" } };
    if (raced) {
      mocks.retrieve.mockResolvedValueOnce({ id: "cs_member", status: "open", payment_status: "unpaid" });
      mocks.expire.mockRejectedValueOnce(new Error("Checkout already completed"));
    }
    mocks.retrieve.mockResolvedValue(paidCheckout);
    mocks.find.mockResolvedValue(active);
    await expect(prepareMembershipCancellation(pending)).resolves.toBe(active);
    expect(mocks.recover).toHaveBeenCalledWith({ membership: pending, checkout: paidCheckout, connectedAccountId: "acct_member" });
    expect(mocks.find).toHaveBeenCalledWith(pending.tenant, pending._id, true);
  });

  it("keeps an asynchronous payment recoverable until its result is confirmed", async () => {
    const pending = membership();
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "complete", payment_status: "unpaid" });
    await expect(prepareMembershipCancellation(pending)).rejects.toMatchObject({ code: "MEMBERSHIP_PAYMENT_CONFIRMATION_PENDING" });
    expect(pending).toMatchObject({ status: "pending", isOpen: true });
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("does not close an already-paid Checkout while local activation is still unresolved", async () => {
    mocks.retrieve.mockResolvedValue(paidCheckout);
    mocks.find.mockResolvedValue(membership());
    await expect(prepareMembershipCancellation(membership())).rejects.toMatchObject({ code: "MEMBERSHIP_PAYMENT_CONFIRMATION_PENDING" });
  });

  it.each(["pending", "past_due"])("recovers the remote subscription for cancellation after a failed initial payment in %s state", async (status) => {
    const pending = { ...membership(), status };
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "complete", payment_status: "unpaid", subscription: "sub_member" });
    mocks.subscription.mockResolvedValue({ id: "sub_member", status: "active", latest_invoice: { status: "void", payment_intent: { status: "requires_payment_method" } } });
    await expect(prepareMembershipCancellation(pending)).resolves.toMatchObject({ stripe: { subscriptionId: "sub_member" }, currentPeriodEnd: null });
    expect(mocks.subscription).toHaveBeenCalledWith("acct_member", "sub_member");
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("keeps a processing subscription payment open even if its invoice snapshot is void", async () => {
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "complete", payment_status: "unpaid", subscription: {
      id: "sub_member", status: "active", latest_invoice: { status: "void", payment_intent: { status: "processing" } },
    } });
    await expect(prepareMembershipCancellation(membership())).rejects.toMatchObject({ code: "MEMBERSHIP_PAYMENT_CONFIRMATION_PENDING" });
  });

  it("allows local closure once the unpaid subscription is already terminal", async () => {
    const pending = membership();
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "complete", payment_status: "unpaid", subscription: { id: "sub_member", status: "canceled", latest_invoice: null } });
    await expect(prepareMembershipCancellation(pending)).resolves.toMatchObject({ stripe: { subscriptionId: "" } });
  });

  it("allows cancellation after Stripe has already expired Checkout", async () => {
    const pending = membership();
    mocks.retrieve.mockResolvedValue({ id: "cs_member", status: "expired", payment_status: "unpaid" });
    await expect(prepareMembershipCancellation(pending)).resolves.toBe(pending);
    expect(mocks.expire).not.toHaveBeenCalled();
  });

  it("does not race creation of a Checkout that has not been attached yet", async () => {
    const pending = membership();
    pending.stripe.checkoutSessionId = "";
    await expect(prepareMembershipCancellation(pending)).rejects.toMatchObject({ code: "MEMBERSHIP_CHECKOUT_CANCELLATION_PENDING" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("leaves paid or manually assigned memberships on the normal cancellation path", async () => {
    const active = { ...membership(), status: "active" };
    await expect(prepareMembershipCancellation(active)).resolves.toBe(active);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});
