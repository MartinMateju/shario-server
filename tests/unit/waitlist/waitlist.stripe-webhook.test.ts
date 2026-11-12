import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processBookingPaymentRefundEvent: vi.fn(),
  processVoucherRefundEvent: vi.fn(),
  refundCreate: vi.fn(),
  refundRetrieve: vi.fn(),
  couponRelease: vi.fn(),
  couponProcess: vi.fn(),
  findOrderSnapshot: vi.fn(),
  releaseExpiredOrder: vi.fn(),
  findRefundSnapshot: vi.fn(),
  recordRefundAttempt: vi.fn(),
  releaseCourseCapacity: vi.fn(),
  markLateOrderRefunded: vi.fn(),
  markOrderFailed: vi.fn(),
  claimStripeOrder: vi.fn(),
  markOrderProcessed: vi.fn(),
  markOrderRetryable: vi.fn(),
  findPaymentAccount: vi.fn(),
  processCourse: vi.fn(),
  processWorkshop: vi.fn(),
  processGuestIncrease: vi.fn(),
  processPromo: vi.fn(),
  processCredits: vi.fn(),
  processCreditPurchase: vi.fn(),
  ensureInvoice: vi.fn(),
  emitBookingCreatedNotifications: vi.fn(),
  claimWaitlist: vi.fn(),
  confirmReplay: vi.fn(),
  confirmWaitlist: vi.fn(),
  expireWaitlist: vi.fn(),
  getWaitlistDisposition: vi.fn(),
  lockSession: vi.fn(),
  markWaitlistRefunded: vi.fn(),
  releaseWaitlistClaim: vi.fn(),
  promote: vi.fn(),
}));

vi.mock("@/modules/booking/services/booking-payment-refund.service.js", () => ({
  processBookingPaymentRefundEvent: mocks.processBookingPaymentRefundEvent,
}));

vi.mock("@/modules/coupon/voucher-refund.service.js", () => ({
  processVoucherRefundEvent: mocks.processVoucherRefundEvent,
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    refunds = {
      create: mocks.refundCreate,
      retrieve: mocks.refundRetrieve,
    };
    webhooks = { constructEvent: vi.fn() };
  },
}));

vi.mock("@/modules/coupon/coupon.service.js", () => ({
  couponService: {
    releaseExpiredCouponOrderFromWebhook: mocks.couponRelease,
    processCouponOrderFromWebhook: mocks.couponProcess,
  },
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    findOrderPaymentSnapshot: mocks.findOrderSnapshot,
    releaseExpiredStripeOrder: mocks.releaseExpiredOrder,
    findWaitlistRefundSnapshot: mocks.findRefundSnapshot,
    recordWaitlistRefundAttempt: mocks.recordRefundAttempt,
    releaseCourseCapacity: mocks.releaseCourseCapacity,
    markLateWaitlistOrderRefunded: mocks.markLateOrderRefunded,
    markOrderFailed: mocks.markOrderFailed,
    claimStripeOrder: mocks.claimStripeOrder,
    markOrderProcessed: mocks.markOrderProcessed,
    markOrderProcessingRetryable: mocks.markOrderRetryable,
  },
}));

vi.mock("@/modules/checkout/services/checkout.webhook.service.js", () => ({
  processCourseBookingsAfterPayment: mocks.processCourse,
  processCreditPurchaseFromWebhook: mocks.processCreditPurchase,
  processCreditsDiscountAfterPayment: mocks.processCredits,
  processGuestIncreaseBookingsAfterPayment: mocks.processGuestIncrease,
  processPromoCodesAfterPayment: mocks.processPromo,
  processWorkshopBookingsAfterPayment: mocks.processWorkshop,
}));

vi.mock("@/modules/invoice/invoice.service.js", () => ({
  ensurePaidOrderInvoice: mocks.ensureInvoice,
}));

vi.mock(
  "@/modules/workspace-notifications/workspace-notification.business-events.js",
  () => ({
    emitBookingCreatedNotificationsForOrderSafely:
      mocks.emitBookingCreatedNotifications,
  }),
);

vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => ({
    findTenantPaymentAccountByStripeAccount: mocks.findPaymentAccount,
  }),
);

vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  claimWaitlistOrderForWebhook: mocks.claimWaitlist,
  confirmProcessedWaitlistReplay: mocks.confirmReplay,
  confirmWaitlistOrderFromWebhook: mocks.confirmWaitlist,
  expireWaitlistOrderAfterStripeSession: mocks.expireWaitlist,
  getWaitlistOrderDisposition: mocks.getWaitlistDisposition,
  lockWaitlistSessionForFulfillment: mocks.lockSession,
  markLateWaitlistPaymentRefunded: mocks.markWaitlistRefunded,
  releaseWaitlistWebhookClaim: mocks.releaseWaitlistClaim,
}));

vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: mocks.promote,
}));

import { stripeWebhookService } from "@/modules/checkout/services/checkout.stripe-webhook.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ORDER_ID = "507f1f77bcf86cd799439012";
const ENTRY_ID = "507f1f77bcf86cd799439013";
const SESSION_ID = "507f1f77bcf86cd799439014";

const checkoutSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_test_waitlist",
  client_reference_id: ORDER_ID,
  metadata: {
    sharioManaged: "true",
    tenantId: TENANT_ID,
    sharioFlow: "order",
  },
  status: "complete",
  payment_status: "paid",
  payment_intent: "pi_waitlist",
  amount_total: 50_000,
  currency: "czk",
  livemode: false,
  ...overrides,
});

const event = (
  type = "checkout.session.completed",
  sessionOverrides: Record<string, unknown> = {},
) =>
  ({
    id: "evt_waitlist",
    type,
    account: "acct_studio",
    livemode: false,
    data: { object: checkoutSession(sessionOverrides) },
  }) as never;

const refundEvent = (status: "pending" | "succeeded" | "failed") =>
  ({
    id: `evt_refund_${status}`,
    type: status === "failed" ? "refund.failed" : "refund.updated",
    account: "acct_studio",
    livemode: false,
    data: {
      object: {
        object: "refund",
        id: "re_waitlist",
        status,
        amount: 50_000,
        currency: "czk",
        livemode: false,
        payment_intent: "pi_waitlist",
        metadata: {
          sharioManaged: "true",
          tenantId: TENANT_ID,
          orderId: ORDER_ID,
          reason: "waitlist_offer_expired",
        },
      },
    },
  }) as never;

const paymentSnapshot = {
  _id: ORDER_ID,
  status: "pending_order",
  currency: "CZK",
  expectedAmountMinor: 50_000,
  stripe: {
    sessionId: "cs_test_waitlist",
    connectedAccountId: "acct_studio",
    livemode: false,
    processedEventIds: [],
  },
};

const waitlistEntry = {
  _id: ENTRY_ID,
  courseSession: SESSION_ID,
  sessionStartSnapshot: new Date("2026-08-10T10:00:00.000Z"),
};

describe("managed Stripe waitlist webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processBookingPaymentRefundEvent.mockResolvedValue(false);
    mocks.processVoucherRefundEvent.mockResolvedValue(false);
    mocks.findPaymentAccount.mockResolvedValue({ tenant: TENANT_ID });
    mocks.findOrderSnapshot.mockResolvedValue(paymentSnapshot);
    mocks.claimStripeOrder.mockResolvedValue({
      _id: ORDER_ID,
      paidAt: new Date("2026-08-07T10:00:00.000Z"),
    });
    mocks.markOrderProcessed.mockResolvedValue({ modifiedCount: 1 });
    mocks.markOrderRetryable.mockResolvedValue(undefined);
    mocks.confirmWaitlist.mockResolvedValue({ modifiedCount: 1 });
    mocks.lockSession.mockResolvedValue(true);
    mocks.ensureInvoice.mockResolvedValue(undefined);
    mocks.emitBookingCreatedNotifications.mockResolvedValue({
      candidateCount: 0,
      emittedCount: 0,
    });
    mocks.refundCreate.mockResolvedValue({
      id: "re_waitlist",
      status: "succeeded",
      amount: 50_000,
    });
    mocks.findRefundSnapshot.mockResolvedValue(null);
    mocks.getWaitlistDisposition.mockResolvedValue({
      kind: "refund",
      entry: waitlistEntry,
    });
    const mongoSession = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(mongoSession as never);
  });

  it("ignores unmanaged, unpaid, and unrelated events", () => {
    expect(
      stripeWebhookService.shouldProcess(
        event("checkout.session.completed", {
          metadata: { sharioManaged: "false" },
        }),
      ),
    ).toBe(false);
    expect(
      stripeWebhookService.shouldProcess(
        event("checkout.session.completed", { payment_status: "unpaid" }),
      ),
    ).toBe(false);
    expect(stripeWebhookService.shouldProcess(event("charge.succeeded"))).toBe(
      false,
    );
    expect(
      stripeWebhookService.shouldProcess(
        event("checkout.session.expired", {
          status: "expired",
          payment_status: "unpaid",
        }),
      ),
    ).toBe(true);
  });

  it("fulfills a live waitlist reservation and confirms the entry and order in one transaction", async () => {
    mocks.claimWaitlist.mockResolvedValue({
      kind: "fulfill",
      entry: waitlistEntry,
      claimToken: "waitlist-lease",
    });

    await stripeWebhookService.processEvent(event());

    expect(mocks.lockSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        entry: waitlistEntry,
        session: expect.anything(),
      }),
    );
    expect(mocks.processCourse).toHaveBeenCalledOnce();
    expect(mocks.confirmWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        claimToken: "waitlist-lease",
        session: expect.anything(),
      }),
    );
    expect(mocks.markOrderProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(mocks.processWorkshop).not.toHaveBeenCalled();
    expect(mocks.ensureInvoice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
    });
  });

  it("returns retryable failure while another webhook owns the waitlist claim", async () => {
    mocks.claimWaitlist.mockResolvedValue({
      kind: "busy",
      entry: waitlistEntry,
    });
    await expect(stripeWebhookService.processEvent(event())).rejects.toThrow(
      /already being fulfilled/,
    );
    expect(mocks.claimStripeOrder).not.toHaveBeenCalled();
  });

  it("refunds a late payment exactly once without fulfilling and releases capacity", async () => {
    mocks.claimWaitlist.mockResolvedValue({
      kind: "refund",
      entry: waitlistEntry,
    });
    await stripeWebhookService.processEvent(event());

    expect(mocks.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_waitlist" }),
      expect.objectContaining({
        stripeAccount: "acct_studio",
        idempotencyKey: `waitlist-unfulfilled-refund:${ORDER_ID}`,
      }),
    );
    expect(mocks.releaseCourseCapacity).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      bookingIds: [SESSION_ID],
    });
    expect(mocks.markWaitlistRefunded).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        refundId: "re_waitlist",
        amountMinor: 50_000,
        currency: "CZK",
      }),
    );
    expect(mocks.markLateOrderRefunded).toHaveBeenCalledOnce();
    expect(mocks.processCourse).not.toHaveBeenCalled();
    expect(mocks.promote).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      automatic: true,
    });
  });

  it("independently finalizes a pending refund from refund.updated without another Checkout event", async () => {
    mocks.findRefundSnapshot.mockResolvedValue({
      currency: "CZK",
      expectedAmountMinor: 50_000,
      waitlist: { entryId: ENTRY_ID },
      waitlistRefund: {
        refundId: "re_waitlist",
        status: "pending",
        amountMinor: 50_000,
      },
      stripe: { connectedAccountId: "acct_studio" },
    });

    expect(stripeWebhookService.shouldProcess(refundEvent("succeeded"))).toBe(
      true,
    );
    await stripeWebhookService.processEvent(refundEvent("succeeded"));

    expect(mocks.recordRefundAttempt).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      refundId: "re_waitlist",
      status: "succeeded",
      amountMinor: 50_000,
    });
    expect(mocks.getWaitlistDisposition).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
    });
    expect(mocks.releaseCourseCapacity).toHaveBeenCalledOnce();
    expect(mocks.markWaitlistRefunded).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "re_waitlist",
        amountMinor: 50_000,
        currency: "CZK",
      }),
    );
    expect(mocks.markLateOrderRefunded).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_refund_succeeded" }),
    );
  });

  it("persists a failed refund update without releasing capacity or claiming it was refunded", async () => {
    mocks.findRefundSnapshot.mockResolvedValue({
      currency: "CZK",
      expectedAmountMinor: 50_000,
      waitlist: { entryId: ENTRY_ID },
      waitlistRefund: {
        refundId: "re_waitlist",
        status: "pending",
        amountMinor: 50_000,
      },
      stripe: { connectedAccountId: "acct_studio" },
    });

    await stripeWebhookService.processEvent(refundEvent("failed"));

    expect(mocks.processBookingPaymentRefundEvent).toHaveBeenCalledWith(
      refundEvent("failed"),
    );
    expect(mocks.processVoucherRefundEvent).toHaveBeenCalledWith(
      refundEvent("failed"),
    );
    expect(mocks.recordRefundAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(mocks.releaseCourseCapacity).not.toHaveBeenCalled();
    expect(mocks.markWaitlistRefunded).not.toHaveBeenCalled();
    expect(mocks.markLateOrderRefunded).not.toHaveBeenCalled();
  });

  it("refunds instead of fulfilling if the Class was cancelled or rescheduled after payment", async () => {
    mocks.claimWaitlist.mockResolvedValue({
      kind: "fulfill",
      entry: waitlistEntry,
      claimToken: "waitlist-lease",
    });
    mocks.lockSession.mockResolvedValue(false);

    await expect(
      stripeWebhookService.processEvent(event()),
    ).resolves.toBeUndefined();
    expect(mocks.processCourse).not.toHaveBeenCalled();
    expect(mocks.markOrderRetryable).toHaveBeenCalledOnce();
    expect(mocks.releaseWaitlistClaim).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      claimToken: "waitlist-lease",
    });
    expect(mocks.refundCreate).toHaveBeenCalledOnce();
    expect(mocks.markWaitlistRefunded).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        terminalState: "cancelled",
      }),
    );
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("expires an unpaid Stripe checkout, releases its order, and promotes the next FIFO entry", async () => {
    mocks.releaseExpiredOrder.mockResolvedValue(true);
    mocks.expireWaitlist.mockResolvedValue({
      entryId: ENTRY_ID,
      sessionId: SESSION_ID,
    });
    await stripeWebhookService.processEvent(
      event("checkout.session.expired", {
        status: "expired",
        payment_status: "unpaid",
        payment_intent: null,
      }),
    );
    expect(mocks.releaseExpiredOrder).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      sessionId: "cs_test_waitlist",
      connectedAccountId: "acct_studio",
    });
    expect(mocks.expireWaitlist).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      stripeSessionId: "cs_test_waitlist",
    });
    expect(mocks.promote).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      automatic: true,
    });
  });
});
