import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOrderPaymentSnapshot: vi.fn(),
  claimLegacyPlatformStripeOrder: vi.fn(),
  markOrderProcessed: vi.fn(),
  markOrderFailed: vi.fn(),
  markOrderProcessingRetryable: vi.fn(),
  releaseExpiredLegacyPlatformStripeOrder: vi.fn(),
  processCreditPurchaseFromWebhook: vi.fn(),
  processCreditsDiscountAfterPayment: vi.fn(),
  processCourseBookingsAfterPayment: vi.fn(),
  processGuestIncreaseBookingsAfterPayment: vi.fn(),
  processPromoCodesAfterPayment: vi.fn(),
  processWorkshopBookingsAfterPayment: vi.fn(),
  processLegacyPlatformCouponOrderFromWebhook: vi.fn(),
  releaseExpiredLegacyPlatformCouponOrderFromWebhook: vi.fn(),
  ensurePaidOrderInvoice: vi.fn(),
  emitBookingCreatedNotifications: vi.fn(),
}));

vi.mock("@/modules/checkout/checkout.repository.js", () => ({
  checkoutRepository: {
    findOrderPaymentSnapshot: mocks.findOrderPaymentSnapshot,
    claimLegacyPlatformStripeOrder: mocks.claimLegacyPlatformStripeOrder,
    markOrderProcessed: mocks.markOrderProcessed,
    markOrderFailed: mocks.markOrderFailed,
    markOrderProcessingRetryable: mocks.markOrderProcessingRetryable,
    releaseExpiredLegacyPlatformStripeOrder:
      mocks.releaseExpiredLegacyPlatformStripeOrder,
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
    processLegacyPlatformCouponOrderFromWebhook:
      mocks.processLegacyPlatformCouponOrderFromWebhook,
    releaseExpiredLegacyPlatformCouponOrderFromWebhook:
      mocks.releaseExpiredLegacyPlatformCouponOrderFromWebhook,
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

import { legacyPlatformCheckoutWebhookService } from "@/modules/checkout/services/checkout.legacy-platform-webhook.service.js";

const TENANT_ID = "64b000000000000000000001";
const ORDER_ID = "64b000000000000000000011";
const COUPON_ORDER_ID = "64b000000000000000000012";

const createPaidEvent = (overrides: Record<string, unknown> = {}) => ({
  id: "evt_legacy_paid",
  type: "checkout.session.completed",
  livemode: false,
  data: {
    object: {
      id: "cs_legacy",
      status: "complete",
      client_reference_id: ORDER_ID,
      payment_status: "paid",
      payment_intent: "pi_legacy",
      amount_total: 2_500,
      currency: "czk",
      livemode: false,
      metadata: { tenantId: TENANT_ID },
    },
  },
  ...overrides,
});

const createOrderSnapshot = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  status: "pending_order",
  currency: "CZK",
  expectedAmountMinor: 2_500,
  stripe: {
    sessionId: "cs_legacy",
    connectedAccountId: "",
    livemode: null,
    processedEventIds: [],
  },
  ...overrides,
});

const createClaimedOrder = (overrides: Record<string, unknown> = {}) => ({
  ...createOrderSnapshot(),
  workshopBookings: [],
  courseBookings: [],
  guestIncreaseBookings: [],
  appliedCoupons: [],
  credits: { appliedMajor: 0, currency: "CZK" },
  creditPurchase: { amount: 0 },
  ...overrides,
});

describe("legacy platform Checkout webhook migration compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_KEY", "sk_test_platform");
    vi.stubEnv("LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED", "true");

    mocks.processWorkshopBookingsAfterPayment.mockResolvedValue(true);
    mocks.processCourseBookingsAfterPayment.mockResolvedValue(true);
    mocks.processGuestIncreaseBookingsAfterPayment.mockResolvedValue(true);
    mocks.processPromoCodesAfterPayment.mockResolvedValue({ ok: true });
    mocks.processCreditsDiscountAfterPayment.mockResolvedValue({ ok: true });
    mocks.processCreditPurchaseFromWebhook.mockResolvedValue(true);
    mocks.markOrderProcessed.mockResolvedValue({ modifiedCount: 1 });
    mocks.markOrderProcessingRetryable.mockResolvedValue({ modifiedCount: 1 });
    mocks.releaseExpiredLegacyPlatformStripeOrder.mockResolvedValue(true);
    mocks.processLegacyPlatformCouponOrderFromWebhook.mockResolvedValue(true);
    mocks.releaseExpiredLegacyPlatformCouponOrderFromWebhook.mockResolvedValue(
      true,
    );
    mocks.ensurePaidOrderInvoice.mockResolvedValue(undefined);
    mocks.emitBookingCreatedNotifications.mockResolvedValue({
      candidateCount: 0,
      emittedCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is default-off and ignores connected-account events", () => {
    vi.stubEnv("LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED", "false");
    expect(
      legacyPlatformCheckoutWebhookService.shouldProcess(
        createPaidEvent() as never,
      ),
    ).toBe(false);

    vi.stubEnv("LEGACY_PLATFORM_CHECKOUT_WEBHOOK_ENABLED", "true");
    expect(
      legacyPlatformCheckoutWebhookService.shouldProcess(
        createPaidEvent({ account: "acct_connected" }) as never,
      ),
    ).toBe(false);
  });

  it("fulfills a pre-Connect platform booking order with a retryable lease", async () => {
    const snapshot = createOrderSnapshot();
    const claimedOrder = createClaimedOrder();
    mocks.findOrderPaymentSnapshot.mockResolvedValue(snapshot);
    mocks.claimLegacyPlatformStripeOrder.mockResolvedValue(claimedOrder);

    const event = createPaidEvent();
    expect(
      legacyPlatformCheckoutWebhookService.shouldProcess(event as never),
    ).toBe(true);

    await legacyPlatformCheckoutWebhookService.processEvent(event as never);

    expect(mocks.claimLegacyPlatformStripeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        eventId: "evt_legacy_paid",
        session: {
          id: "cs_legacy",
          payment_intent: "pi_legacy",
          currency: "CZK",
          amount_total: 2_500,
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
        orderId: ORDER_ID,
        eventId: "evt_legacy_paid",
      }),
    );
    expect(mocks.emitBookingCreatedNotifications).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      order: claimedOrder,
    });
    expect(
      mocks.markOrderProcessed.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.emitBookingCreatedNotifications.mock.invocationCallOrder[0],
    );
    expect(mocks.ensurePaidOrderInvoice).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
    });
  });

  it("fulfills an old studio-credit purchase without booking fulfillment", async () => {
    mocks.findOrderPaymentSnapshot.mockResolvedValue(createOrderSnapshot());
    const claimedOrder = createClaimedOrder({
      creditPurchase: { amount: 25 },
    });
    mocks.claimLegacyPlatformStripeOrder.mockResolvedValue(claimedOrder);

    await legacyPlatformCheckoutWebhookService.processEvent(
      createPaidEvent() as never,
    );

    expect(mocks.processCreditPurchaseFromWebhook).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      order: claimedOrder,
    });
    expect(mocks.processWorkshopBookingsAfterPayment).not.toHaveBeenCalled();
    expect(mocks.processCreditsDiscountAfterPayment).not.toHaveBeenCalled();
  });

  it("never claims an order with a populated Connect account snapshot", async () => {
    mocks.findOrderPaymentSnapshot.mockResolvedValue(
      createOrderSnapshot({
        stripe: {
          sessionId: "cs_legacy",
          connectedAccountId: "acct_connected",
          livemode: false,
          processedEventIds: [],
        },
      }),
    );

    await expect(
      legacyPlatformCheckoutWebhookService.processEvent(
        createPaidEvent() as never,
      ),
    ).rejects.toThrow(/snapshot mismatch/);

    expect(mocks.claimLegacyPlatformStripeOrder).not.toHaveBeenCalled();
    expect(mocks.markOrderFailed).not.toHaveBeenCalled();
  });

  it("delegates pre-Connect voucher fulfillment through the legacy-safe path", async () => {
    const event = createPaidEvent({
      data: {
        object: {
          ...createPaidEvent().data.object,
          client_reference_id: `CO_${COUPON_ORDER_ID}`,
        },
      },
    });

    await legacyPlatformCheckoutWebhookService.processEvent(event as never);

    expect(
      mocks.processLegacyPlatformCouponOrderFromWebhook,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      session: event.data.object,
      eventId: "evt_legacy_paid",
      livemode: false,
    });
    expect(mocks.claimLegacyPlatformStripeOrder).not.toHaveBeenCalled();
  });

  it("releases only a snapshot-matched pre-Connect order on Session expiry", async () => {
    mocks.findOrderPaymentSnapshot.mockResolvedValue(createOrderSnapshot());
    const event = createPaidEvent({
      id: "evt_legacy_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          ...createPaidEvent().data.object,
          status: "expired",
          payment_status: "unpaid",
          payment_intent: null,
        },
      },
    });

    await legacyPlatformCheckoutWebhookService.processEvent(event as never);

    expect(
      mocks.releaseExpiredLegacyPlatformStripeOrder,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      sessionId: "cs_legacy",
      currency: "CZK",
      amountTotal: 2_500,
      livemode: false,
    });
    expect(mocks.claimLegacyPlatformStripeOrder).not.toHaveBeenCalled();
  });

  it("delegates legacy voucher Session expiry without touching normal orders", async () => {
    const event = createPaidEvent({
      id: "evt_legacy_voucher_expired",
      type: "checkout.session.expired",
      data: {
        object: {
          ...createPaidEvent().data.object,
          status: "expired",
          payment_status: "unpaid",
          payment_intent: null,
          client_reference_id: `CO_${COUPON_ORDER_ID}`,
        },
      },
    });

    await legacyPlatformCheckoutWebhookService.processEvent(event as never);

    expect(
      mocks.releaseExpiredLegacyPlatformCouponOrderFromWebhook,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      session: event.data.object,
      livemode: false,
    });
    expect(mocks.findOrderPaymentSnapshot).not.toHaveBeenCalled();
  });

  it("releases a failed fulfillment claim so Stripe can retry", async () => {
    const failure = new Error("temporary booking write failure");
    mocks.findOrderPaymentSnapshot.mockResolvedValue(createOrderSnapshot());
    mocks.claimLegacyPlatformStripeOrder.mockResolvedValue(
      createClaimedOrder(),
    );
    mocks.processCourseBookingsAfterPayment.mockRejectedValue(failure);

    await expect(
      legacyPlatformCheckoutWebhookService.processEvent(
        createPaidEvent() as never,
      ),
    ).rejects.toThrow("temporary booking write failure");

    expect(mocks.markOrderProcessingRetryable).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      error: failure,
      claimToken: expect.any(String),
    });
    expect(mocks.markOrderProcessed).not.toHaveBeenCalled();
    expect(mocks.emitBookingCreatedNotifications).not.toHaveBeenCalled();
  });
});
