import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processBookingPaymentRefundEvent: vi.fn(),
  processVoucherRefundEvent: vi.fn(),
  commitCheckoutVouchers: vi.fn(),
  transaction: vi.fn(),
  findOrderPaymentSnapshot: vi.fn(),
  claimStripeOrder: vi.fn(),
  markOrderProcessed: vi.fn(),
  markOrderFailed: vi.fn(),
  markOrderProcessingRetryable: vi.fn(),
  releaseExpiredStripeOrder: vi.fn(),
  processCreditPurchaseFromWebhook: vi.fn(),
  processCreditsDiscountAfterPayment: vi.fn(),
  processCourseBookingsAfterPayment: vi.fn(),
  processGuestIncreaseBookingsAfterPayment: vi.fn(),
  processPromoCodesAfterPayment: vi.fn(),
  processWorkshopBookingsAfterPayment: vi.fn(),
  processCouponOrderFromWebhook: vi.fn(),
  ensurePaidOrderInvoice: vi.fn(),
  findTenantPaymentAccountByStripeAccount: vi.fn(),
  claimWaitlistOrderForWebhook: vi.fn(),
  confirmProcessedWaitlistReplay: vi.fn(),
  confirmWaitlistOrderFromWebhook: vi.fn(),
  expireWaitlistOrderAfterStripeSession: vi.fn(),
  getWaitlistOrderDisposition: vi.fn(),
  lockWaitlistSessionForFulfillment: vi.fn(),
  markLateWaitlistPaymentRefunded: vi.fn(),
  releaseWaitlistWebhookClaim: vi.fn(),
  promoteWaitlistEntry: vi.fn(),
  emitBookingCreatedNotifications: vi.fn(),
}));

vi.mock("@/modules/booking/services/booking-payment-refund.service.js", () => ({
  processBookingPaymentRefundEvent: mocks.processBookingPaymentRefundEvent,
}));
vi.mock("@/modules/coupon/voucher-refund.service.js", () => ({
  processVoucherRefundEvent: mocks.processVoucherRefundEvent,
}));

vi.mock("@/modules/checkout/services/checkout.voucher.service.js", () => ({
  commitCheckoutVouchers: mocks.commitCheckoutVouchers,
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    findOrderPaymentSnapshot: mocks.findOrderPaymentSnapshot,
    claimStripeOrder: mocks.claimStripeOrder,
    markOrderProcessed: mocks.markOrderProcessed,
    markOrderFailed: mocks.markOrderFailed,
    markOrderProcessingRetryable: mocks.markOrderProcessingRetryable,
    releaseExpiredStripeOrder: mocks.releaseExpiredStripeOrder,
  },
}));

vi.mock("@/modules/checkout/services/checkout.webhook.service.js", () => ({
  processCreditPurchaseFromWebhook: mocks.processCreditPurchaseFromWebhook,
  processCreditsDiscountAfterPayment: mocks.processCreditsDiscountAfterPayment,
  processCourseBookingsAfterPayment: mocks.processCourseBookingsAfterPayment,
  processGuestIncreaseBookingsAfterPayment:
    mocks.processGuestIncreaseBookingsAfterPayment,
  processPromoCodesAfterPayment: mocks.processPromoCodesAfterPayment,
  processWorkshopBookingsAfterPayment:
    mocks.processWorkshopBookingsAfterPayment,
}));

vi.mock("@/modules/coupon/coupon.service.js", () => ({
  couponService: {
    processCouponOrderFromWebhook: mocks.processCouponOrderFromWebhook,
  },
}));

vi.mock("@/modules/invoice/invoice.service.js", () => ({
  ensurePaidOrderInvoice: mocks.ensurePaidOrderInvoice,
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
    findTenantPaymentAccountByStripeAccount:
      mocks.findTenantPaymentAccountByStripeAccount,
  }),
);

vi.mock("@/modules/waitlist/waitlist.checkout.service.js", () => ({
  claimWaitlistOrderForWebhook: mocks.claimWaitlistOrderForWebhook,
  confirmProcessedWaitlistReplay: mocks.confirmProcessedWaitlistReplay,
  confirmWaitlistOrderFromWebhook: mocks.confirmWaitlistOrderFromWebhook,
  expireWaitlistOrderAfterStripeSession:
    mocks.expireWaitlistOrderAfterStripeSession,
  getWaitlistOrderDisposition: mocks.getWaitlistOrderDisposition,
  lockWaitlistSessionForFulfillment: mocks.lockWaitlistSessionForFulfillment,
  markLateWaitlistPaymentRefunded: mocks.markLateWaitlistPaymentRefunded,
  releaseWaitlistWebhookClaim: mocks.releaseWaitlistWebhookClaim,
}));

vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: mocks.promoteWaitlistEntry,
}));

import { stripeWebhookService } from "@/modules/checkout/services/checkout.stripe-webhook.service.js";

const TENANT_ID = "64b000000000000000000001";
const OLDER_ORDER_ID = "64b000000000000000000011";
const OLDER_BOOKING_ID = "64b000000000000000000021";
const CONNECTED_ACCOUNT_ID = "acct_tenant";

describe("Stripe Checkout webhook lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processWorkshopBookingsAfterPayment.mockResolvedValue(true);
    mocks.processCourseBookingsAfterPayment.mockResolvedValue(true);
    mocks.processGuestIncreaseBookingsAfterPayment.mockResolvedValue(true);
    mocks.processPromoCodesAfterPayment.mockResolvedValue({ ok: true });
    mocks.processCreditsDiscountAfterPayment.mockResolvedValue({ ok: true });
    mocks.markOrderProcessed.mockResolvedValue({ modifiedCount: 1 });
    mocks.markOrderProcessingRetryable.mockResolvedValue({ modifiedCount: 1 });
    mocks.ensurePaidOrderInvoice.mockResolvedValue(undefined);
    mocks.emitBookingCreatedNotifications.mockResolvedValue({
      candidateCount: 1,
      emittedCount: 1,
    });
    mocks.releaseExpiredStripeOrder.mockResolvedValue(true);
    mocks.claimWaitlistOrderForWebhook.mockResolvedValue({
      kind: "not_waitlist",
    });
    mocks.expireWaitlistOrderAfterStripeSession.mockResolvedValue(null);
    mocks.findTenantPaymentAccountByStripeAccount.mockResolvedValue({
      tenant: TENANT_ID,
    });
  });

  it.each([false, true])(
    "fulfills voucher and card payment in one transaction; failure=%s",
    async (failBooking) => {
      const mongoSession = { inTransaction: () => true };
      const transaction = vi
        .spyOn(mongoose.connection, "transaction")
        .mockImplementation(async (callback: any) => callback(mongoSession));
      const snapshot = {
        _id: OLDER_ORDER_ID,
        status: "pending_order",
        currency: "CZK",
        expectedAmountMinor: 2500,
        stripe: {
          sessionId: "cs_voucher",
          connectedAccountId: CONNECTED_ACCOUNT_ID,
          livemode: false,
          processedEventIds: [],
        },
      };
      const claimedOrder = {
        ...snapshot,
        tenant: TENANT_ID,
        createdBy: "64b000000000000000000099",
        workshopBookings: [OLDER_BOOKING_ID],
        courseBookings: [],
        guestIncreaseBookings: [],
        voucherRedemptions: [
          {
            couponId: "64b000000000000000000098",
            reservationId: "held",
            lineIndex: 0,
            appliedAmountMinor: 5000,
            amountMinor: 5000,
            quantity: 0,
          },
        ],
      };
      mocks.findOrderPaymentSnapshot.mockResolvedValue(snapshot);
      mocks.claimStripeOrder.mockResolvedValue(claimedOrder);
      mocks.commitCheckoutVouchers.mockResolvedValue(undefined);
      if (failBooking)
        mocks.processCourseBookingsAfterPayment.mockRejectedValueOnce(
          new Error("Booking unavailable"),
        );
      const event = {
        id: "evt_voucher_paid",
        type: "checkout.session.completed",
        account: CONNECTED_ACCOUNT_ID,
        livemode: false,
        data: {
          object: {
            id: "cs_voucher",
            client_reference_id: OLDER_ORDER_ID,
            status: "complete",
            payment_status: "paid",
            payment_intent: "pi_voucher",
            amount_total: 2500,
            currency: "czk",
            livemode: false,
            metadata: {
              sharioManaged: "true",
              sharioFlow: "order",
              tenantId: TENANT_ID,
            },
          },
        },
      };
      try {
        if (failBooking) {
          await expect(
            stripeWebhookService.processEvent(event as never),
          ).rejects.toThrow("Booking unavailable");
          expect(mocks.markOrderProcessed).not.toHaveBeenCalled();
          expect(mocks.markOrderProcessingRetryable).toHaveBeenCalledOnce();
        } else {
          await stripeWebhookService.processEvent(event as never);
          expect(mocks.markOrderProcessed).toHaveBeenCalledWith(
            expect.objectContaining({ session: mongoSession }),
          );
        }
        expect(transaction).toHaveBeenCalledOnce();
        expect(mocks.commitCheckoutVouchers).toHaveBeenCalledWith({
          tenantId: TENANT_ID,
          order: claimedOrder,
          session: mongoSession,
          paymentState: "paid",
        });
        expect(mocks.processWorkshopBookingsAfterPayment).toHaveBeenCalledWith(
          claimedOrder,
          { tenantId: TENANT_ID, session: mongoSession },
        );
        expect(mocks.processPromoCodesAfterPayment).not.toHaveBeenCalled();
        expect(mocks.processCreditsDiscountAfterPayment).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
    },
  );

  it("routes a signed late booking refund failure before waitlist metadata filtering", async () => {
    const event = {
      id: "evt_late_booking_failure",
      type: "refund.failed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "re_booking",
          object: "refund",
          status: "failed",
          payment_intent: "pi_booking",
          metadata: {},
        },
      },
    };
    mocks.processBookingPaymentRefundEvent.mockResolvedValueOnce(true);
    expect(stripeWebhookService.shouldProcess(event)).toBe(true);
    await stripeWebhookService.processEvent(event as never);
    expect(mocks.processBookingPaymentRefundEvent).toHaveBeenCalledWith(event);
    expect(mocks.processVoucherRefundEvent).not.toHaveBeenCalled();
    expect(mocks.claimStripeOrder).not.toHaveBeenCalled();
  });

  it.each([
    { status: "open", payment_status: "paid" },
    { status: "complete", payment_status: "unpaid" },
  ])(
    "requires confirmed payment before voucher fulfillment %j",
    async (proof) => {
      const snapshot = {
        _id: OLDER_ORDER_ID,
        status: "pending_order",
        currency: "CZK",
        expectedAmountMinor: 2500,
        voucherRedemptions: [{ reservationId: "held" }],
        stripe: {
          sessionId: "cs_voucher",
          connectedAccountId: CONNECTED_ACCOUNT_ID,
          livemode: false,
          processedEventIds: [],
        },
      };
      mocks.findOrderPaymentSnapshot.mockResolvedValueOnce(snapshot);
      const event = {
        id: "evt_unconfirmed",
        type: "checkout.session.completed",
        account: CONNECTED_ACCOUNT_ID,
        livemode: false,
        data: {
          object: {
            id: "cs_voucher",
            client_reference_id: OLDER_ORDER_ID,
            ...proof,
            payment_intent: "pi_voucher",
            amount_total: 2500,
            currency: "czk",
            livemode: false,
            metadata: {
              sharioManaged: "true",
              sharioFlow: "order",
              tenantId: TENANT_ID,
            },
          },
        },
      };
      await expect(
        stripeWebhookService.processEvent(event as never),
      ).rejects.toThrow("completed and paid");
      expect(mocks.claimStripeOrder).not.toHaveBeenCalled();
      expect(mocks.commitCheckoutVouchers).not.toHaveBeenCalled();
    },
  );

  it("fulfills payment from the older of two Checkout tabs", async () => {
    const snapshot = {
      _id: OLDER_ORDER_ID,
      status: "pending_order",
      currency: "CZK",
      expectedAmountMinor: 2_500,
      stripe: {
        sessionId: "cs_older",
        connectedAccountId: CONNECTED_ACCOUNT_ID,
        livemode: false,
        processedEventIds: [],
      },
    };
    const claimedOrder = {
      ...snapshot,
      workshopBookings: [OLDER_BOOKING_ID],
      courseBookings: [],
      guestIncreaseBookings: [],
      appliedCoupons: [],
      credits: { appliedMajor: 0, currency: "CZK" },
      creditPurchase: { amount: 0 },
    };
    mocks.findOrderPaymentSnapshot.mockResolvedValue(snapshot);
    mocks.claimStripeOrder.mockResolvedValue(claimedOrder);

    const event = {
      id: "evt_older_paid",
      type: "checkout.session.completed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_older",
          client_reference_id: OLDER_ORDER_ID,
          payment_status: "paid",
          payment_intent: "pi_older",
          amount_total: 2_500,
          currency: "czk",
          livemode: false,
          metadata: {
            sharioManaged: "true",
            sharioFlow: "order",
            tenantId: TENANT_ID,
          },
        },
      },
    };

    expect(stripeWebhookService.shouldProcess(event)).toBe(true);
    await stripeWebhookService.processEvent(event as never);

    expect(mocks.findOrderPaymentSnapshot).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: OLDER_ORDER_ID,
    });
    expect(mocks.claimStripeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: OLDER_ORDER_ID,
        eventId: "evt_older_paid",
        session: {
          id: "cs_older",
          payment_intent: "pi_older",
          currency: "CZK",
          amount_total: 2_500,
          connectedAccountId: CONNECTED_ACCOUNT_ID,
          livemode: false,
        },
      }),
    );
    expect(mocks.processWorkshopBookingsAfterPayment).toHaveBeenCalledWith(
      claimedOrder,
      { tenantId: TENANT_ID },
    );
    expect(mocks.markOrderProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: OLDER_ORDER_ID,
        eventId: "evt_older_paid",
      }),
    );
    expect(mocks.emitBookingCreatedNotifications).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      order: claimedOrder,
    });
    expect(mocks.markOrderProcessed.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emitBookingCreatedNotifications.mock.invocationCallOrder[0],
    );
    expect(mocks.ensurePaidOrderInvoice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: OLDER_ORDER_ID,
    });
  });

  it("releases only the tenant-and-session-matched order on Session expiry", async () => {
    mocks.findOrderPaymentSnapshot.mockResolvedValue({
      _id: OLDER_ORDER_ID,
      stripe: {
        sessionId: "cs_expired",
        connectedAccountId: CONNECTED_ACCOUNT_ID,
        livemode: false,
      },
    });

    const event = {
      id: "evt_expired",
      type: "checkout.session.expired",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_expired",
          status: "expired",
          client_reference_id: OLDER_ORDER_ID,
          payment_status: "unpaid",
          livemode: false,
          metadata: {
            sharioManaged: "true",
            sharioFlow: "order",
            tenantId: TENANT_ID,
          },
        },
      },
    };

    expect(stripeWebhookService.shouldProcess(event)).toBe(true);
    await stripeWebhookService.processEvent(event as never);

    expect(mocks.releaseExpiredStripeOrder).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: OLDER_ORDER_ID,
      sessionId: "cs_expired",
      connectedAccountId: CONNECTED_ACCOUNT_ID,
    });
    expect(mocks.findOrderPaymentSnapshot).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: OLDER_ORDER_ID,
    });
    expect(mocks.claimStripeOrder).not.toHaveBeenCalled();
  });

  it("ignores a connected-account Checkout Session not created by Shario", async () => {
    const event = {
      id: "evt_merchant_session",
      type: "checkout.session.completed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_merchant",
          payment_status: "paid",
          client_reference_id: "merchant-reference",
          metadata: {},
        },
      },
    };

    expect(stripeWebhookService.shouldProcess(event)).toBe(false);
    expect(mocks.findOrderPaymentSnapshot).not.toHaveBeenCalled();
  });

  it("fails a namespaced paid Session with a malformed durable reference", async () => {
    const event = {
      id: "evt_malformed",
      type: "checkout.session.completed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_malformed",
          livemode: false,
          payment_status: "paid",
          client_reference_id: "not-an-order-id",
          metadata: {
            sharioManaged: "true",
            sharioFlow: "order",
            tenantId: TENANT_ID,
          },
        },
      },
    };

    expect(stripeWebhookService.shouldProcess(event)).toBe(true);
    await expect(
      stripeWebhookService.processEvent(event as never),
    ).rejects.toThrow(/invalid durable reference/);
  });

  it("fails a namespaced paid Session when its durable order is missing", async () => {
    mocks.findOrderPaymentSnapshot.mockResolvedValue(null);
    const event = {
      id: "evt_missing_order",
      type: "checkout.session.completed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_missing_order",
          livemode: false,
          payment_status: "paid",
          payment_intent: "pi_missing_order",
          amount_total: 1_000,
          currency: "czk",
          client_reference_id: OLDER_ORDER_ID,
          metadata: {
            sharioManaged: "true",
            sharioFlow: "order",
            tenantId: TENANT_ID,
          },
        },
      },
    };

    await expect(
      stripeWebhookService.processEvent(event as never),
    ).rejects.toThrow(/no durable order/);
  });

  it("releases transient fulfillment failures for a non-terminal retry", async () => {
    const snapshot = {
      _id: OLDER_ORDER_ID,
      status: "pending_order",
      currency: "CZK",
      expectedAmountMinor: 2_500,
      stripe: {
        sessionId: "cs_retry",
        connectedAccountId: CONNECTED_ACCOUNT_ID,
        livemode: false,
        processedEventIds: [],
      },
    };
    const claimedOrder = {
      ...snapshot,
      workshopBookings: [OLDER_BOOKING_ID],
      courseBookings: [],
      guestIncreaseBookings: [],
      appliedCoupons: [],
      credits: { appliedMajor: 0, currency: "CZK" },
      creditPurchase: { amount: 0 },
    };
    const fulfillmentError = new Error("temporary database outage");
    mocks.findOrderPaymentSnapshot.mockResolvedValue(snapshot);
    mocks.claimStripeOrder.mockResolvedValue(claimedOrder);
    mocks.processWorkshopBookingsAfterPayment.mockRejectedValue(
      fulfillmentError,
    );

    const event = {
      id: "evt_retry_paid",
      type: "checkout.session.completed",
      account: CONNECTED_ACCOUNT_ID,
      livemode: false,
      data: {
        object: {
          id: "cs_retry",
          client_reference_id: OLDER_ORDER_ID,
          payment_status: "paid",
          payment_intent: "pi_retry",
          amount_total: 2_500,
          currency: "czk",
          livemode: false,
          metadata: {
            sharioManaged: "true",
            sharioFlow: "order",
            tenantId: TENANT_ID,
          },
        },
      },
    };

    await expect(
      stripeWebhookService.processEvent(event as never),
    ).rejects.toThrow("temporary database outage");
    expect(mocks.markOrderProcessingRetryable).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: OLDER_ORDER_ID,
      error: fulfillmentError,
      claimToken: expect.any(String),
    });
    expect(mocks.markOrderFailed).not.toHaveBeenCalled();
    expect(mocks.markOrderProcessed).not.toHaveBeenCalled();
    expect(mocks.emitBookingCreatedNotifications).not.toHaveBeenCalled();
  });
});
