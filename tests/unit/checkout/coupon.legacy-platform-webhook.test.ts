import { afterEach, describe, expect, it, vi } from "vitest";

import { COUPON_STATUS } from "@/modules/coupon/coupon.constants.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { couponService } from "@/modules/coupon/coupon.service.js";

const TENANT_ID = "64b000000000000000000001";
const COUPON_ORDER_ID = "64b000000000000000000012";

const createSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_legacy_voucher",
  status: "complete",
  client_reference_id: `CO_${COUPON_ORDER_ID}`,
  payment_status: "paid",
  payment_intent: "pi_legacy_voucher",
  amount_total: 5_000,
  currency: "czk",
  livemode: false,
  metadata: { tenantId: TENANT_ID },
  ...overrides,
});

const createOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: COUPON_ORDER_ID,
  tenant: TENANT_ID,
  status: COUPON_STATUS.PENDING_PAYMENT,
  processedAt: null,
  processedStripeEventIds: [],
  stripeSessionId: "cs_legacy_voucher",
  stripeConnectedAccountId: "",
  stripeLivemode: null,
  currencySnapshot: "CZK",
  expectedAmountMinor: 5_000,
  totalSnapshot: 50,
  ...overrides,
});

describe("legacy platform voucher webhook compatibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("atomically binds the legacy snapshot before voucher fulfillment", async () => {
    const order = createOrder();
    vi.spyOn(couponRepository, "findCouponOrderByIdForTenant")
      .mockResolvedValue(order as never);
    vi.spyOn(couponRepository, "bindLegacyPlatformCouponOrderSnapshot")
      .mockResolvedValue(true);
    const confirm = vi.spyOn(couponRepository, "recordConfirmedCouponPayment")
      .mockResolvedValue(undefined);
    vi.spyOn(couponService, "finalizePaidCouponOrder")
      .mockResolvedValue(true);

    const session = createSession();
    await expect(
      couponService.processLegacyPlatformCouponOrderFromWebhook({
        tenantId: TENANT_ID,
        session: session as never,
        eventId: "evt_legacy_voucher",
        livemode: false,
      }),
    ).resolves.toBe(true);

    expect(
      couponRepository.bindLegacyPlatformCouponOrderSnapshot,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      couponOrderId: COUPON_ORDER_ID,
      sessionId: "cs_legacy_voucher",
      currency: "CZK",
      storedExpectedAmountMinor: 5_000,
      livemode: false,
    });
    expect(confirm).toHaveBeenCalledWith({
      tenantId: TENANT_ID, couponOrderId: COUPON_ORDER_ID, sessionId: "cs_legacy_voucher",
      paymentIntentId: "pi_legacy_voucher", paidAt: expect.any(Date),
    });
    expect(confirm.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(couponRepository.bindLegacyPlatformCouponOrderSnapshot).mock.invocationCallOrder[0]);
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(couponService.finalizePaidCouponOrder).mock.invocationCallOrder[0]);
    expect(couponService.finalizePaidCouponOrder).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      couponOrderId: COUPON_ORDER_ID,
      sessionId: "cs_legacy_voucher",
      eventId: "evt_legacy_voucher",
      paymentIntentId: "pi_legacy_voucher",
    });
  });

  it("rejects a voucher order owned by a connected account", async () => {
    vi.spyOn(couponRepository, "findCouponOrderByIdForTenant")
      .mockResolvedValue(
        createOrder({ stripeConnectedAccountId: "acct_connected" }) as never,
      );
    const bind = vi
      .spyOn(couponRepository, "bindLegacyPlatformCouponOrderSnapshot")
      .mockResolvedValue(true);
    const finalize = vi
      .spyOn(couponService, "finalizePaidCouponOrder")
      .mockResolvedValue(true);

    await expect(
      couponService.processLegacyPlatformCouponOrderFromWebhook({
        tenantId: TENANT_ID,
        session: createSession() as never,
        eventId: "evt_wrong_path",
        livemode: false,
      }),
    ).rejects.toThrow(/connected-account voucher order/);

    expect(bind).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("expires only a fully matched legacy voucher snapshot", async () => {
    vi.spyOn(couponRepository, "findCouponOrderByIdForTenant")
      .mockResolvedValue(createOrder() as never);
    const release = vi
      .spyOn(couponRepository, "releaseExpiredLegacyPlatformCouponOrder")
      .mockResolvedValue(true);

    const session = createSession({
      status: "expired",
      payment_status: "unpaid",
      payment_intent: null,
    });

    await expect(
      couponService.releaseExpiredLegacyPlatformCouponOrderFromWebhook({
        tenantId: TENANT_ID,
        session: session as never,
        livemode: false,
      }),
    ).resolves.toBe(true);

    expect(release).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      couponOrderId: COUPON_ORDER_ID,
      sessionId: "cs_legacy_voucher",
      currency: "CZK",
      storedExpectedAmountMinor: 5_000,
      livemode: false,
    });
  });
});
