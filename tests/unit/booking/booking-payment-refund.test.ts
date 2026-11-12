import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { Order } from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";

const mocks = vi.hoisted(() => ({
  retrieveIntent: vi.fn(),
  listRefunds: vi.fn(),
  createRefund: vi.fn(),
  retrieveRefund: vi.fn(),
  reverse: vi.fn(),
  lock: vi.fn(),
  livemode: vi.fn(),
}));
vi.mock("@/modules/coupon/voucher-lifecycle.service.js", () => ({
  reverseVoucherInSession: mocks.reverse,
}));
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.lock,
}));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    paymentIntents: { retrieve: mocks.retrieveIntent },
    refunds: {
      create: mocks.createRefund,
      retrieve: mocks.retrieveRefund,
      list: mocks.listRefunds,
    },
  }),
  getTenantPaymentStripeLivemode: mocks.livemode,
  getConnectedAccountRequestOptions: (account: string) => ({
    stripeAccount: account,
  }),
}));
import {
  processBookingPaymentRefunds,
  processBookingPaymentRefundEvent,
  reconcileBookingCardRefund,
  refundBookingOriginalPaymentInSession,
  resolveOriginalPaymentRefund,
  serializeBookingPaymentRefund,
} from "@/modules/booking/services/booking-payment-refund.service.js";

const tenantId = "64b000000000000000000001";
const orderId = "64b000000000000000000002";
const bookingId = "64b000000000000000000003";
const otherBooking = "64b000000000000000000004";
const couponId = "64b000000000000000000005";
const userId = "64b000000000000000000006";
const now = new Date("2026-09-15T12:00:00Z");
const query = (result: any) => {
  const q: any = { exec: vi.fn().mockResolvedValue(result) };
  for (const method of ["lean", "select", "session", "sort"])
    q[method] = vi.fn(() => q);
  return q;
};
const paidOrder = (overrides: any = {}) => ({
  _id: new mongoose.Types.ObjectId(orderId),
  tenant: new mongoose.Types.ObjectId(tenantId),
  createdBy: new mongoose.Types.ObjectId(userId),
  isPaid: true,
  status: "processed_order",
  currency: "CZK",
  grossAmountMinor: 30000,
  expectedAmountMinor: 15000,
  lineItems: [
    { booking: bookingId, grossAmountMinor: 10000 },
    { booking: otherBooking, grossAmountMinor: 20000 },
  ],
  voucherRedemptions: [
    {
      couponId,
      reservationId: "line-0",
      lineIndex: 0,
      amountMinor: 5000,
      quantity: 0,
      appliedAmountMinor: 5000,
    },
    {
      couponId,
      reservationId: "line-1",
      lineIndex: 1,
      amountMinor: 10000,
      quantity: 0,
      appliedAmountMinor: 10000,
    },
  ],
  paymentAllocations: [
    { method: "voucher", amountMinor: 15000 },
    { method: "stripe", amountMinor: 15000 },
  ],
  stripe: {
    connectedAccountId: "acct_original",
    livemode: false,
    paymentIntentId: "pi_original",
  },
  ...overrides,
});
const record = (overrides: any = {}) => ({
  _id: `${tenantId}:${orderId}:${bookingId}`,
  tenant: new mongoose.Types.ObjectId(tenantId),
  order: new mongoose.Types.ObjectId(orderId),
  booking: new mongoose.Types.ObjectId(bookingId),
  currency: "CZK",
  amountMinor: 10000,
  voucherAmountMinor: 5000,
  voucherQuantity: 0,
  cardAmountMinor: 5000,
  paymentIntentId: "pi_original",
  connectedAccountId: "acct_original",
  livemode: false,
  refundId: "",
  firstProviderAttemptAt: now,
  status: "pending",
  attempts: 1,
  ...overrides,
});
const refund = (overrides: any = {}) => ({
  id: "re_original",
  status: "succeeded",
  amount: 5000,
  currency: "czk",
  payment_intent: "pi_original",
  metadata: {
    sharioBookingRefundId: `${tenantId}:${orderId}:${bookingId}`,
    tenantId,
    orderId,
    bookingId,
  },
  ...overrides,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.livemode.mockReturnValue(false);
  mocks.retrieveIntent.mockResolvedValue({
    id: "pi_original",
    livemode: false,
    currency: "czk",
    status: "succeeded",
    amount: 15000,
    amount_received: 15000,
  });
  mocks.listRefunds.mockResolvedValue({ data: [], has_more: false });
  mocks.createRefund.mockResolvedValue(refund());
  mocks.retrieveRefund.mockResolvedValue(refund());
  vi.spyOn(Order, "findOne").mockReturnValue(query(paidOrder()) as never);
});

describe("original booking refund allocation", () => {
  it("returns only one cancelled session's exact voucher and card shares", () => {
    const first = resolveOriginalPaymentRefund(paidOrder(), bookingId)!;
    const second = resolveOriginalPaymentRefund(paidOrder(), otherBooking)!;
    expect(first).toMatchObject({
      amountMinor: 10000,
      voucherAmountMinor: 5000,
      cardAmountMinor: 5000,
      redemptions: [{ reservationId: "line-0" }],
    });
    expect(second).toMatchObject({
      amountMinor: 20000,
      voucherAmountMinor: 10000,
      cardAmountMinor: 10000,
      redemptions: [{ reservationId: "line-1" }],
    });
    expect(first.cardAmountMinor + second.cardAmountMinor).toBe(15000);
  });
  it("restores experience quantity using its financial allocation without converting it to money", () => {
    const order = paidOrder();
    order.voucherRedemptions[0] = {
      ...order.voucherRedemptions[0],
      amountMinor: 0,
      quantity: 2,
    };
    expect(resolveOriginalPaymentRefund(order, bookingId)).toMatchObject({
      voucherQuantity: 2,
      voucherAmountMinor: 5000,
      cardAmountMinor: 5000,
    });
  });
  it("preserves the legacy credit refund path when there is no voucher allocation", () => {
    expect(
      resolveOriginalPaymentRefund(
        { paymentAllocations: [{ method: "credits", amountMinor: 10000 }] },
        bookingId,
      ),
    ).toBeNull();
  });
  it.each([
    { voucherRedemptions: [] },
    { lineItems: [] },
    { isPaid: false },
    { expectedAmountMinor: 1 },
    {
      voucherRedemptions: [
        {
          couponId,
          reservationId: "bad",
          lineIndex: 0,
          amountMinor: 10001,
          quantity: 0,
          appliedAmountMinor: 10001,
        },
      ],
    },
    {
      paymentAllocations: [
        { method: "credits", amountMinor: 15000 },
        { method: "voucher", amountMinor: 15000 },
      ],
    },
  ])(
    "fails closed instead of inferring missing or inconsistent funding: %j",
    (overrides) => {
      expect(() =>
        resolveOriginalPaymentRefund(paidOrder(overrides), bookingId),
      ).toThrow();
    },
  );
  it("rejects duplicate reservation identities and unknown bookings", () => {
    const order = paidOrder();
    order.voucherRedemptions[1].reservationId = "line-0";
    expect(() => resolveOriginalPaymentRefund(order, bookingId)).toThrow(
      /allocation is invalid/i,
    );
    expect(() => resolveOriginalPaymentRefund(paidOrder(), userId)).toThrow(
      /no immutable line/i,
    );
  });
});

describe("transactional cancellation intent", () => {
  const session: any = { inTransaction: () => true };
  const input = {
    tenantId,
    orderId,
    bookingId,
    actorId: userId,
    reason: "Customer cancellation",
    session,
    now,
  };
  it("restores the selected reservation and saves a durable refund in the caller's transaction without Stripe I/O", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(null) as never,
    );
    const create = vi
      .spyOn(BookingPaymentRefund, "create")
      .mockResolvedValue([record()] as never);
    const result = await refundBookingOriginalPaymentInSession(input);
    expect(Order.findOne).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId(orderId),
      tenant: new mongoose.Types.ObjectId(tenantId),
      isPaid: true,
    });
    expect(mocks.reverse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        reservationId: "line-0",
        amountMinor: 5000,
        quantity: 0,
        referenceId: orderId,
        operationId: `booking-refund:${orderId}:${bookingId}:0`,
      }),
      session,
    );
    expect(create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          cardAmountMinor: 5000,
          status: "pending",
          nextAttemptAt: now,
        }),
      ],
      { session },
    );
    expect(result?.idempotent).toBe(false);
    expect(mocks.retrieveIntent).not.toHaveBeenCalled();
  });
  it("replays an existing intent without restoring again", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(record()) as never,
    );
    const create = vi.spyOn(BookingPaymentRefund, "create");
    expect(
      (await refundBookingOriginalPaymentInSession(input))?.idempotent,
    ).toBe(true);
    expect(mocks.reverse).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("aborts when voucher restoration requires review; no card refund is scheduled", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(null) as never,
    );
    const create = vi.spyOn(BookingPaymentRefund, "create");
    mocks.reverse.mockRejectedValueOnce(
      new Error("Revoked voucher requires reconciliation"),
    );
    await expect(refundBookingOriginalPaymentInSession(input)).rejects.toThrow(
      /Revoked/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("Stripe booking refund reconciliation", () => {
  it("refunds only the card remainder to the immutable connected account using a stable key", async () => {
    expect(await reconcileBookingCardRefund(record(), now)).toMatchObject({
      refundId: "re_original",
      status: "succeeded",
    });
    await reconcileBookingCardRefund(record(), now);
    expect(mocks.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5000, payment_intent: "pi_original" }),
      expect.objectContaining({
        stripeAccount: "acct_original",
        idempotencyKey: expect.stringMatching(/^booking-refund:[a-f0-9]{64}$/),
      }),
    );
    expect(mocks.createRefund.mock.calls[0][1].idempotencyKey).toBe(
      mocks.createRefund.mock.calls[1][1].idempotencyKey,
    );
  });
  it("recovers a remote refund after a crash without making a second create call", async () => {
    mocks.listRefunds.mockResolvedValue({ data: [refund()], has_more: false });
    expect(
      await reconcileBookingCardRefund(
        record({ firstProviderAttemptAt: new Date("2026-09-01") }),
        now,
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });
  it("does not recreate an unknown refund after the safe idempotency window", async () => {
    await expect(
      reconcileBookingCardRefund(
        record({
          firstProviderAttemptAt: new Date(now.getTime() - 22 * 3600000),
        }),
        now,
      ),
    ).rejects.toThrow(/safe automatic retry window/);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });
  it("reconciles a known pending refund and records provider failure as review", async () => {
    mocks.retrieveRefund
      .mockResolvedValueOnce(refund({ status: "pending" }))
      .mockResolvedValueOnce(refund({ status: "failed" }));
    expect(
      await reconcileBookingCardRefund(
        record({ refundId: "re_original" }),
        now,
      ),
    ).toMatchObject({ status: "provider_pending" });
    expect(
      await reconcileBookingCardRefund(
        record({ refundId: "re_original" }),
        now,
      ),
    ).toMatchObject({ status: "review_required" });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });
  it("requires explicit review for an unrelated dashboard refund", async () => {
    mocks.listRefunds.mockResolvedValue({
      data: [refund({ metadata: {} })],
      has_more: false,
    });
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(null) as never,
    );
    await expect(reconcileBookingCardRefund(record(), now)).rejects.toThrow(
      /external payment refund/,
    );
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });
  it.each([
    { amount: 14999 },
    { amount_received: 14999 },
    { currency: "eur" },
    { livemode: true },
    { status: "processing" },
  ])(
    "rejects contradictory original payment evidence: %j",
    async (overrides) => {
      mocks.retrieveIntent.mockResolvedValue({
        id: "pi_original",
        livemode: false,
        currency: "czk",
        status: "succeeded",
        amount: 15000,
        amount_received: 15000,
        ...overrides,
      });
      await expect(reconcileBookingCardRefund(record(), now)).rejects.toThrow();
      expect(mocks.createRefund).not.toHaveBeenCalled();
    },
  );
  it("refuses a mismatched refund response", async () => {
    mocks.createRefund.mockResolvedValue(refund({ amount: 10000 }));
    await expect(reconcileBookingCardRefund(record(), now)).rejects.toThrow(
      /does not match/,
    );
  });
});

describe("late booking card refund failures", () => {
  const event = (overrides: any = {}) =>
    ({
      id: "evt_refund_failure",
      type: "refund.failed",
      account: "acct_original",
      livemode: false,
      data: { object: { ...refund({ status: "failed" }), object: "refund" } },
      ...overrides,
    }) as any;

  it.each(["failed", "canceled"])(
    "marks a previously successful %s refund for review and invalidates an outstanding claim",
    async (status) => {
      vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
        query(
          record({
            status: "succeeded",
            refundId: "re_original",
            claimToken: "stale-claim",
            completedAt: now,
          }),
        ) as never,
      );
      const update = vi
        .spyOn(BookingPaymentRefund, "updateOne")
        .mockReturnValue(query({ matchedCount: 1 }) as never);
      const input = event({
        type: "refund.updated",
        data: { object: { ...refund({ status }), object: "refund" } },
      });
      expect(await processBookingPaymentRefundEvent(input)).toBe(true);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: record().tenant,
          order: record().order,
          connectedAccountId: "acct_original",
          paymentIntentId: "pi_original",
          cardAmountMinor: 5000,
          currency: "CZK",
          livemode: false,
          refundId: { $in: ["", null, "re_original"] },
        }),
        {
          $set: expect.objectContaining({
            status: "review_required",
            providerStatus: status,
            failureEventId: "evt_refund_failure",
            failureRecordedAt: expect.any(Date),
            claimToken: "",
            claimExpiresAt: null,
            nextAttemptAt: null,
            completedAt: null,
          }),
        },
      );
      expect(mocks.reverse).not.toHaveBeenCalled();
      expect(mocks.createRefund).not.toHaveBeenCalled();
    },
  );

  it("handles failure arriving before the create response is persisted using the already-attempted intent", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(record({ refundId: "", status: "processing" })) as never,
    );
    vi.spyOn(BookingPaymentRefund, "updateOne").mockReturnValue(
      query({ matchedCount: 1 }) as never,
    );
    expect(await processBookingPaymentRefundEvent(event())).toBe(true);
    expect(BookingPaymentRefund.findOne).toHaveBeenCalledWith({
      connectedAccountId: "acct_original",
      $or: [
        { refundId: "re_original" },
        { _id: record()._id, refundId: { $in: ["", null] } },
      ],
    });
  });

  it("does not attach an unrelated refund to an intent that has never reached the provider", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(record({ refundId: "", firstProviderAttemptAt: null })) as never,
    );
    const update = vi.spyOn(BookingPaymentRefund, "updateOne");
    expect(await processBookingPaymentRefundEvent(event())).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("supports an exact saved refund ID if dashboard editing removed metadata", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(record({ refundId: "re_original" })) as never,
    );
    vi.spyOn(BookingPaymentRefund, "updateOne").mockReturnValue(
      query({ matchedCount: 1 }) as never,
    );
    expect(
      await processBookingPaymentRefundEvent(
        event({
          data: {
            object: {
              ...refund({ status: "failed", metadata: {} }),
              object: "refund",
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    { amount: 10000 },
    { currency: "eur" },
    { payment_intent: "pi_other" },
    { metadata: { ...refund().metadata, tenantId: otherBooking } },
  ])(
    "rejects contradictory refund evidence without changing the saved outcome: %j",
    async (overrides) => {
      vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
        query(record({ refundId: "re_original" })) as never,
      );
      const update = vi.spyOn(BookingPaymentRefund, "updateOne");
      await expect(
        processBookingPaymentRefundEvent(
          event({
            data: {
              object: {
                ...refund({ status: "failed", ...overrides }),
                object: "refund",
              },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("ignores another account's refund and never upgrades a late successful event", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(null) as never,
    );
    expect(
      await processBookingPaymentRefundEvent(event({ account: "acct_other" })),
    ).toBe(false);
    expect(BookingPaymentRefund.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ connectedAccountId: "acct_other" }),
    );
    vi.mocked(BookingPaymentRefund.findOne).mockClear();
    expect(
      await processBookingPaymentRefundEvent(
        event({
          data: {
            object: { ...refund({ status: "succeeded" }), object: "refund" },
          },
        }),
      ),
    ).toBe(false);
    expect(BookingPaymentRefund.findOne).not.toHaveBeenCalled();
  });

  it("rejects mode and original order mismatches and keeps terminal failure out of provider reconciliation", async () => {
    vi.spyOn(BookingPaymentRefund, "findOne").mockReturnValue(
      query(record({ refundId: "re_original" })) as never,
    );
    await expect(
      processBookingPaymentRefundEvent(event({ livemode: true })),
    ).rejects.toThrow(/saved payment snapshot/);
    vi.mocked(Order.findOne).mockReturnValue(query(null) as never);
    await expect(processBookingPaymentRefundEvent(event())).rejects.toThrow(
      /matching original order/,
    );
    await expect(
      reconcileBookingCardRefund(record({ failureRecordedAt: now }), now),
    ).rejects.toThrow(/requires review/);
    expect(mocks.createRefund).not.toHaveBeenCalled();
  });
});

describe("durable refund worker", () => {
  it("persists the first-attempt timestamp before provider I/O and fences completion", async () => {
    const claim = vi
      .spyOn(BookingPaymentRefund, "findOneAndUpdate")
      .mockReturnValueOnce(
        query(
          record({ firstProviderAttemptAt: null, status: "processing" }),
        ) as never,
      )
      .mockReturnValue(query(null) as never);
    const updates: any[] = [];
    vi.spyOn(BookingPaymentRefund, "updateOne").mockImplementation(
      (filter: any, update: any) => {
        updates.push({ filter, update });
        return query({ modifiedCount: 1 }) as never;
      },
    );
    mocks.retrieveIntent.mockImplementationOnce(async () => {
      expect(updates[0].update.$set.firstProviderAttemptAt).toEqual(now);
      return {
        id: "pi_original",
        livemode: false,
        currency: "czk",
        status: "succeeded",
        amount: 15000,
        amount_received: 15000,
      };
    });
    expect(await processBookingPaymentRefunds({ now, limit: 1 })).toEqual({
      processed: 1,
    });
    const claimToken = (claim.mock.calls[0][1] as any).$set.claimToken;
    expect(updates[1]).toMatchObject({
      filter: {
        _id: record()._id,
        tenant: record().tenant,
        claimToken,
        status: "processing",
      },
      update: {
        $set: {
          status: "succeeded",
          refundId: "re_original",
          nextAttemptAt: null,
        },
      },
    });
  });
  it("keeps a provider timeout retryable and never exposes provider credentials in customer DTOs", async () => {
    vi.spyOn(BookingPaymentRefund, "findOneAndUpdate")
      .mockReturnValueOnce(query(record()) as never)
      .mockReturnValue(query(null) as never);
    const update = vi
      .spyOn(BookingPaymentRefund, "updateOne")
      .mockReturnValue(query({ modifiedCount: 1 }) as never);
    mocks.createRefund.mockRejectedValueOnce(
      new Error("timeout: secret provider internals"),
    );
    await processBookingPaymentRefunds({ now, limit: 1 });
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "pending",
          nextAttemptAt: expect.any(Date),
          lastError: expect.not.stringContaining("secret"),
        }),
      }),
    );
    expect(serializeBookingPaymentRefund(record())).not.toHaveProperty(
      "paymentIntentId",
    );
    expect(serializeBookingPaymentRefund(record())).not.toHaveProperty(
      "connectedAccountId",
    );
  });
});
