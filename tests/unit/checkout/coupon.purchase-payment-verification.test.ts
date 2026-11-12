import { afterEach, describe, expect, it, vi } from "vitest";

import { COUPON_STATUS } from "@/modules/coupon/coupon.constants.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { couponService } from "@/modules/coupon/coupon.service.js";

const tenantId = "64b000000000000000000001";
const couponOrderId = "64b000000000000000000012";
const connectedAccountId = "acct_voucher_tenant";

const paidSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_voucher_purchase",
  status: "complete",
  client_reference_id: `CO_${couponOrderId}`,
  payment_status: "paid",
  payment_intent: "pi_voucher_purchase",
  amount_total: 5_000,
  currency: "czk",
  livemode: false,
  metadata: {
    tenantId,
    couponOrderId,
    sharioManaged: "true",
    sharioFlow: "voucher-purchase",
  },
  ...overrides,
});

const order = (overrides: Record<string, unknown> = {}) => ({
  _id: couponOrderId,
  tenant: tenantId,
  status: COUPON_STATUS.PENDING_PAYMENT,
  processedAt: null,
  processedStripeEventIds: [],
  stripeSessionId: "cs_voucher_purchase",
  stripeConnectedAccountId: connectedAccountId,
  stripeLivemode: false,
  currencySnapshot: "CZK",
  expectedAmountMinor: 5_000,
  totalSnapshot: 50,
  ...overrides,
});

const processPurchase = (session = paidSession()) =>
  couponService.processCouponOrderFromWebhook({
    tenantId,
    session: session as never,
    connectedAccountId,
    eventId: "evt_voucher_purchase",
    livemode: false,
    paidAt: new Date("2026-09-15T12:00:00Z"),
  });

describe("voucher purchase verified payment boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["unpaid checkout", { payment_status: "unpaid" }, {}, /not paid/],
    ["incomplete checkout", { status: "open" }, {}, /not paid/],
    [
      "contradictory tenant metadata",
      { metadata: { tenantId: "64b000000000000000000099" } },
      {},
      /metadata/,
    ],
    [
      "contradictory order metadata",
      { metadata: { couponOrderId: "64b000000000000000000099" } },
      {},
      /metadata/,
    ],
    ["incorrect amount", { amount_total: 4_999 }, {}, /amount mismatch/],
    ["missing amount", { amount_total: null }, {}, /amount mismatch/],
    ["incorrect currency", { currency: "eur" }, {}, /currency mismatch/],
    [
      "incorrect checkout",
      { id: "cs_other_purchase" },
      {},
      /snapshot mismatch/,
    ],
    [
      "different connected account",
      {},
      { stripeConnectedAccountId: "acct_other_tenant" },
      /snapshot mismatch/,
    ],
    ["different live mode", {}, { stripeLivemode: true }, /snapshot mismatch/],
  ])(
    "does not issue or enqueue for %s",
    async (_label, sessionOverrides, orderOverrides, message) => {
      const lookup = vi
        .spyOn(couponRepository, "findCouponOrderByIdForTenant")
        .mockResolvedValue(
          order(orderOverrides as Record<string, unknown>) as never,
        );
      const confirm = vi
        .spyOn(couponRepository, "recordConfirmedCouponPayment")
        .mockResolvedValue(undefined);
      const finalize = vi
        .spyOn(couponService, "finalizePaidCouponOrder")
        .mockResolvedValue(true);

      await expect(
        processPurchase(
          paidSession(sessionOverrides as Record<string, unknown>),
        ),
      ).rejects.toThrow(message as RegExp);

      expect(lookup).toHaveBeenCalledWith(tenantId, couponOrderId);
      expect(confirm).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
    },
  );

  it("durably confirms a matched payment before issuance and retries a busy issuance lease", async () => {
    vi.spyOn(
      couponRepository,
      "findCouponOrderByIdForTenant",
    ).mockResolvedValue(order() as never);
    const confirm = vi
      .spyOn(couponRepository, "recordConfirmedCouponPayment")
      .mockResolvedValue(undefined);
    const finalize = vi
      .spyOn(couponService, "finalizePaidCouponOrder")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(processPurchase()).rejects.toThrow("already being processed");
    expect(confirm).toHaveBeenCalledWith({
      tenantId,
      couponOrderId,
      sessionId: "cs_voucher_purchase",
      paymentIntentId: "pi_voucher_purchase",
      paidAt: new Date("2026-09-15T12:00:00Z"),
    });
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
      finalize.mock.invocationCallOrder[0],
    );
    await expect(processPurchase()).resolves.toBe(true);
  });

  it("stops issuance when durable payment confirmation cannot be recorded", async () => {
    vi.spyOn(
      couponRepository,
      "findCouponOrderByIdForTenant",
    ).mockResolvedValue(order() as never);
    vi.spyOn(
      couponRepository,
      "recordConfirmedCouponPayment",
    ).mockRejectedValue(new Error("Payment snapshot changed"));
    const finalize = vi
      .spyOn(couponService, "finalizePaidCouponOrder")
      .mockResolvedValue(true);

    await expect(processPurchase()).rejects.toThrow("Payment snapshot changed");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not use another tenant's order when the reference exists outside this workspace", async () => {
    const lookup = vi
      .spyOn(couponRepository, "findCouponOrderByIdForTenant")
      .mockResolvedValue(null);
    const confirm = vi
      .spyOn(couponRepository, "recordConfirmedCouponPayment")
      .mockResolvedValue(undefined);
    const finalize = vi
      .spyOn(couponService, "finalizePaidCouponOrder")
      .mockResolvedValue(true);

    await expect(processPurchase()).rejects.toThrow("Coupon order not found");

    expect(lookup).toHaveBeenCalledWith(tenantId, couponOrderId);
    expect(confirm).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
});
