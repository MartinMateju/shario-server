import mongoose from "mongoose";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orderFindOne: vi.fn(),
  couponFind: vi.fn(),
  account: vi.fn(),
  retrieveIntent: vi.fn(),
  retrieveCheckout: vi.fn(),
  retrieveCharge: vi.fn(),
  tenantLock: vi.fn(),
  revoke: vi.fn(),
  managementUpdate: vi.fn(),
  managementExists: vi.fn(),
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { findOne: mocks.orderFindOne },
  Coupon: { find: mocks.couponFind },
}));
vi.mock(
  "@/modules/coupon/voucher-lifecycle.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/coupon/voucher-lifecycle.service.js")
    >()),
    revokeVoucherInSession: mocks.revoke,
  }),
);
vi.mock(
  "@/modules/coupon/voucher-management-refund.model.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/coupon/voucher-management-refund.model.js")
    >()),
    VoucherManagementRefund: {
      updateOne: mocks.managementUpdate,
      exists: mocks.managementExists,
    },
  }),
);
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({
  acquireVoucherTenantMutationLock: mocks.tenantLock,
}));
vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => ({ findTenantPaymentAccountByStripeAccount: mocks.account }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    paymentIntents: { retrieve: mocks.retrieveIntent },
    checkout: { sessions: { retrieve: mocks.retrieveCheckout } },
    charges: { retrieve: mocks.retrieveCharge },
  }),
  getConnectedAccountRequestOptions: (stripeAccount: string) => ({
    stripeAccount,
  }),
}));

import {
  processVoucherRefundEvent,
  voucherRefundDisposition,
} from "@/modules/coupon/voucher-refund.service.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const orderId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const accountId = "acct_voucher_tenant";
const intentId = "pi_voucher_purchase";
const session = { inTransaction: () => true } as mongoose.ClientSession;
const query = (record: unknown) => {
  const chain: any = { exec: vi.fn(async () => record) };
  chain.lean = vi.fn(() => chain);
  chain.session = vi.fn((actualSession: mongoose.ClientSession) => {
    expect(actualSession).toBe(session);
    return chain;
  });
  return chain;
};
const refundEvent = (
  charge: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
) =>
  ({
    id: "evt_refund_1",
    type: "charge.refunded",
    account: accountId,
    livemode: false,
    data: {
      object: {
        id: "ch_voucher",
        object: "charge",
        payment_intent: intentId,
        amount: 10_000,
        amount_refunded: 10_000,
        currency: "czk",
        livemode: false,
        ...charge,
      },
    },
    ...event,
  }) as unknown as Stripe.Event;
const failedRefundEvent = (
  refund: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
) =>
  ({
    id: "evt_refund_failed",
    type: "refund.failed",
    account: accountId,
    livemode: false,
    data: {
      object: {
        id: "re_voucher",
        object: "refund",
        charge: "ch_voucher",
        payment_intent: intentId,
        amount: 10_000,
        currency: "czk",
        status: "failed",
        ...refund,
      },
    },
    ...event,
  }) as unknown as Stripe.Event;
const voucher = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: new mongoose.Types.ObjectId(),
    tenant: tenantId,
    order: orderId,
    isActive: true,
    lifecycleVersion: 1,
    voucherTypeSnapshot: "value",
    valueMinorSnapshot: 10_000,
    currencySnapshot: "CZK",
    remainingValueMinor: 10_000,
    reservedValueMinor: 0,
    reservedQuantity: 0,
    refundReviewRequired: false,
    save: vi.fn(async () => undefined),
    ...overrides,
  }) as any;
let order: any;
let coupons: any[];
let intent: any;
let checkout: any;

beforeEach(() => {
  vi.clearAllMocks();
  order = {
    _id: orderId,
    tenant: tenantId,
    stripeConnectedAccountId: accountId,
    stripePaymentIntentId: intentId,
    stripeLivemode: false,
    currencySnapshot: "CZK",
    expectedAmountMinor: 10_000,
    totalSnapshot: 100,
    stripeSessionId: "cs_voucher",
    refundedAmountMinor: 0,
    refundState: "none",
    refundFailureReviewRequired: false,
    processedRefundEventIds: [],
    save: vi.fn(async () => undefined),
  };
  coupons = [voucher()];
  intent = {
    id: intentId,
    livemode: false,
    currency: "czk",
    amount: 10_000,
    metadata: {
      sharioManaged: "true",
      sharioFlow: "voucher-purchase",
      tenantId,
      couponOrderId: orderId,
    },
  };
  checkout = {
    id: "cs_voucher",
    payment_intent: intentId,
    livemode: false,
    currency: "czk",
    amount_total: 10_000,
  };
  vi.spyOn(mongoose.connection, "transaction").mockImplementation(
    async (callback) => callback(session),
  );
  mocks.account.mockImplementation(async (id: string) =>
    id === accountId ? { tenant: tenantId } : null,
  );
  mocks.retrieveIntent.mockImplementation(async () => intent);
  mocks.retrieveCheckout.mockImplementation(async () => checkout);
  mocks.retrieveCharge.mockImplementation(
    async () => refundEvent({ amount_refunded: 0 }).data.object,
  );
  mocks.orderFindOne.mockImplementation((filter: Record<string, unknown>) =>
    query(
      Object.entries(filter).every(
        ([key, value]) => String(order?.[key]) === String(value),
      )
        ? order
        : null,
    ),
  );
  mocks.couponFind.mockImplementation((filter: Record<string, unknown>) =>
    query(
      coupons.filter((coupon) =>
        Object.entries(filter).every(
          ([key, value]) => String(coupon[key]) === String(value),
        ),
      ),
    ),
  );
  mocks.managementUpdate.mockReturnValue(
    query({ matchedCount: 0, modifiedCount: 0 }),
  );
  mocks.managementExists.mockReturnValue(query(null));
  mocks.tenantLock.mockResolvedValue(undefined);
  mocks.revoke.mockResolvedValue(undefined);
});

describe("voucher cumulative refund classification", () => {
  it("distinguishes partial, full, duplicate, and out-of-order cumulative amounts", () => {
    expect(
      voucherRefundDisposition({
        expectedAmountMinor: 10_000,
        amountRefundedMinor: 1_000,
      }),
    ).toBe("partial");
    expect(
      voucherRefundDisposition({
        expectedAmountMinor: 10_000,
        amountRefundedMinor: 10_000,
        previousRefundedMinor: 1_000,
      }),
    ).toBe("full");
    expect(
      voucherRefundDisposition({
        expectedAmountMinor: 10_000,
        amountRefundedMinor: 1_000,
        previousRefundedMinor: 1_000,
      }),
    ).toBe("replay");
    expect(
      voucherRefundDisposition({
        expectedAmountMinor: 10_000,
        amountRefundedMinor: 1_000,
        previousRefundedMinor: 10_000,
      }),
    ).toBe("replay");
  });

  it.each([
    { expectedAmountMinor: 0, amountRefundedMinor: 0 },
    { expectedAmountMinor: 10_000, amountRefundedMinor: 10_001 },
    { expectedAmountMinor: 10_000, amountRefundedMinor: -1 },
    { expectedAmountMinor: 10_000, amountRefundedMinor: 0.5 },
    {
      expectedAmountMinor: 10_000,
      amountRefundedMinor: 1,
      previousRefundedMinor: NaN,
    },
  ])("rejects invalid money snapshots: %j", (input) => {
    expect(() => voucherRefundDisposition(input)).toThrow();
  });
});

describe("voucher purchase refund reconciliation", () => {
  it.each([9000, 19000])("reconciles postal purchase refund %i against the full paid total without changing face value", async (amountRefunded) => {
    order.expectedAmountMinor = 19000;
    order.totalSnapshot = 190;
    order.unitPriceSnapshot = 100;
    order.shippingFeeSnapshot = 90;
    order.sendPost = true;
    intent.amount = 19000;
    checkout.amount_total = 19000;
    expect(await processVoucherRefundEvent(refundEvent({
      amount: 19000, amount_refunded: amountRefunded,
    }))).toBe(true);
    expect(coupons[0].valueMinorSnapshot).toBe(10000);
    expect(order.refundedAmountMinor).toBe(amountRefunded);
    if (amountRefunded === 19000) {
      expect(mocks.revoke).toHaveBeenCalledOnce();
      expect(order.refundState).toBe("revoked");
    } else {
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(order.refundState).toBe("manual_review");
      expect(coupons[0].refundReviewRequired).toBe(true);
    }
  });

  it("revokes each unused code in the same tenant-locked transaction and preserves face value", async () => {
    coupons.push(voucher(), voucher({ revokedAt: new Date() }));
    expect(await processVoucherRefundEvent(refundEvent())).toBe(true);
    expect(mocks.tenantLock).toHaveBeenCalledWith(tenantId, session);
    expect(mocks.tenantLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.orderFindOne.mock.invocationCallOrder[1],
    );
    expect(mocks.orderFindOne).toHaveBeenNthCalledWith(1, {
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
      stripePaymentIntentId: intentId,
    });
    expect(mocks.orderFindOne).toHaveBeenNthCalledWith(2, {
      _id: orderId,
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
    });
    expect(mocks.couponFind).toHaveBeenCalledWith({
      tenant: tenantId,
      order: orderId,
    });
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
    for (const coupon of coupons.slice(0, 2)) {
      expect(mocks.revoke).toHaveBeenCalledWith(
        {
          tenantId,
          couponId: coupon._id,
          operationId: `refund:${intentId}:${coupon._id}`,
          reason: "Voucher purchase fully refunded through Stripe",
        },
        session,
      );
      expect(coupon.remainingValueMinor).toBe(10_000);
    }
    expect(order).toMatchObject({
      refundState: "revoked",
      refundedAmountMinor: 10_000,
      processedRefundEventIds: ["evt_refund_1"],
    });
    expect(order.save).toHaveBeenCalledWith({ session });
    expect(mocks.retrieveIntent).not.toHaveBeenCalled();
  });

  it.each([
    {
      redeemedAt: new Date("2026-09-01"),
      redeemedBy: "cccccccccccccccccccccccc",
      remainingValueMinor: 0,
    },
    { remainingValueMinor: 7_000 },
    {
      voucherTypeSnapshot: "experience",
      remainingQuantity: 1,
      voucherSettingsSnapshot: { experienceQuantity: 2 },
    },
    { reservedValueMinor: 1_000 },
    { reservedQuantity: 1 },
    {
      reservedOrder: "cccccccccccccccccccccccc",
      reservedUntil: new Date("2020-01-01"),
    },
  ])(
    "quarantines a used or held voucher without reversing its value or redemption: %j",
    async (state) => {
      const affected = voucher(state);
      coupons = [affected, voucher()];
      const original = {
        remainingValueMinor: affected.remainingValueMinor,
        remainingQuantity: affected.remainingQuantity,
        reservedValueMinor: affected.reservedValueMinor,
        reservedQuantity: affected.reservedQuantity,
        reservedOrder: affected.reservedOrder,
        redeemedAt: affected.redeemedAt,
        redeemedBy: affected.redeemedBy,
      };
      await processVoucherRefundEvent(refundEvent());
      expect(order.refundState).toBe("manual_review");
      expect(order.refundReviewReason).toContain("account credits");
      expect(affected.refundReviewRequired).toBe(true);
      for (const [key, value] of Object.entries(original))
        expect(affected[key]).toEqual(value);
      expect(affected.save).toHaveBeenCalledWith({ session });
      expect(mocks.revoke).toHaveBeenCalledTimes(1);
      expect(mocks.revoke.mock.calls[0][0].couponId).toEqual(coupons[1]._id);
    },
  );

  it("quarantines all unrevoked codes after a partial refund, retaining their balances", async () => {
    coupons.push(voucher({ remainingValueMinor: 7_000 }));
    await processVoucherRefundEvent(refundEvent({ amount_refunded: 1_000 }));
    expect(order).toMatchObject({
      refundState: "manual_review",
      refundedAmountMinor: 1_000,
    });
    expect(order.refundReviewReason).toContain("Partial purchase refund");
    expect(coupons.map((coupon) => coupon.refundReviewRequired)).toEqual([
      true,
      true,
    ]);
    expect(coupons.map((coupon) => coupon.remainingValueMinor)).toEqual([
      10_000, 7_000,
    ]);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("reconciles a later full refund after a partial refund without reviving or consuming codes", async () => {
    await processVoucherRefundEvent(refundEvent({ amount_refunded: 1_000 }));
    await processVoucherRefundEvent(refundEvent({}, { id: "evt_refund_full" }));
    expect(order).toMatchObject({
      refundState: "revoked",
      refundedAmountMinor: 10_000,
      processedRefundEventIds: ["evt_refund_1", "evt_refund_full"],
    });
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(coupons[0].remainingValueMinor).toBe(10_000);
  });

  it("does not revoke again for duplicate events or regress state for older cumulative refunds", async () => {
    await processVoucherRefundEvent(refundEvent());
    await processVoucherRefundEvent(refundEvent());
    await processVoucherRefundEvent(
      refundEvent({ amount_refunded: 1_000 }, { id: "evt_older_partial" }),
    );
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(mocks.couponFind).toHaveBeenCalledTimes(1);
    expect(order).toMatchObject({
      refundState: "revoked",
      refundedAmountMinor: 10_000,
      processedRefundEventIds: ["evt_refund_1", "evt_older_partial"],
    });
  });

  it("records a refund arriving before issuance using the connected PaymentIntent metadata", async () => {
    order.stripePaymentIntentId = "";
    coupons = [];
    expect(await processVoucherRefundEvent(refundEvent())).toBe(true);
    expect(mocks.retrieveIntent).toHaveBeenCalledWith(
      intentId,
      {},
      { stripeAccount: accountId },
    );
    expect(mocks.retrieveCheckout).toHaveBeenCalledWith(
      "cs_voucher",
      {},
      { stripeAccount: accountId },
    );
    expect(mocks.orderFindOne).toHaveBeenNthCalledWith(2, {
      _id: orderId,
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
    });
    expect(order).toMatchObject({
      stripePaymentIntentId: intentId,
      refundState: "revoked",
      refundedAmountMinor: 10_000,
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("holds an unissued order for review when its early refund is partial", async () => {
    order.stripePaymentIntentId = "";
    coupons = [];
    await processVoucherRefundEvent(refundEvent({ amount_refunded: 1_000 }));
    expect(order).toMatchObject({
      refundState: "manual_review",
      refundedAmountMinor: 1_000,
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("uses the immutable total and currency snapshots for legacy orders without a minor-unit total", async () => {
    order.expectedAmountMinor = 0;
    await processVoucherRefundEvent(refundEvent());
    expect(order).toMatchObject({
      refundState: "revoked",
      refundedAmountMinor: 10_000,
    });
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("voucher refund payment ownership and snapshot validation", () => {
  it.each([
    refundEvent({}, { type: "charge.succeeded" }),
    refundEvent({}, { account: undefined }),
    refundEvent({ payment_intent: null }),
    refundEvent({ object: "payment_intent" }),
    refundEvent({}, { account: "acct_unknown" }),
  ])(
    "ignores unsupported or unrecognized events without opening a transaction",
    async (event) => {
      expect(await processVoucherRefundEvent(event)).toBe(false);
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );

  it("does not associate another tenant's order even when PaymentIntent references match", async () => {
    order.tenant = "cccccccccccccccccccccccc";
    intent.metadata = { sharioManaged: "true", sharioFlow: "booking" };
    expect(await processVoucherRefundEvent(refundEvent())).toBe(false);
    expect(mocks.orderFindOne).toHaveBeenCalledWith({
      tenant: tenantId,
      stripeConnectedAccountId: accountId,
      stripePaymentIntentId: intentId,
    });
    expect(order.save).not.toHaveBeenCalled();
    expect(mongoose.connection.transaction).not.toHaveBeenCalled();
  });

  it("refuses an order on another connected account even with valid voucher metadata", async () => {
    order.stripeConnectedAccountId = "acct_other";
    await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
      "no matching order",
    );
    expect(order.save).not.toHaveBeenCalled();
    expect(mongoose.connection.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { sharioManaged: "false", sharioFlow: "voucher-purchase" },
    { sharioManaged: "true", sharioFlow: "booking" },
    {},
  ])(
    "ignores unrelated PaymentIntents rather than claiming them as voucher refunds: %j",
    async (metadata) => {
      order.stripePaymentIntentId = "";
      intent.metadata = metadata;
      expect(await processVoucherRefundEvent(refundEvent())).toBe(false);
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { tenantId: "cccccccccccccccccccccccc" },
    { couponOrderId: "invalid" },
  ])(
    "rejects mismatched or malformed server order metadata: %j",
    async (metadata) => {
      order.stripePaymentIntentId = "";
      Object.assign(intent.metadata, metadata);
      await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
        "tenant metadata mismatch",
      );
      expect(order.save).not.toHaveBeenCalled();
    },
  );

  it("rejects charge and envelope livemode disagreement before looking up orders", async () => {
    await expect(
      processVoucherRefundEvent(refundEvent({ livemode: true })),
    ).rejects.toThrow("livemode mismatch");
    expect(mocks.orderFindOne).not.toHaveBeenCalled();
  });

  it.each([{ livemode: true }, { currency: "eur" }, { amount: 9_999 }])(
    "validates the metadata fallback PaymentIntent snapshot: %j",
    async (mismatch) => {
      order.stripePaymentIntentId = "";
      Object.assign(intent, mismatch);
      await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
        "purchase snapshot mismatch",
      );
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
      expect(order.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    { id: "cs_other" },
    { payment_intent: "pi_other" },
    { livemode: true },
    { currency: "eur" },
    { amount_total: 9_999 },
  ])(
    "rejects PaymentIntent metadata unless the saved Checkout Session proves ownership: %j",
    async (mismatch) => {
      order.stripePaymentIntentId = "";
      Object.assign(checkout, mismatch);
      await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
        "stored Checkout Session",
      );
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
      expect(order.save).not.toHaveBeenCalled();
    },
  );

  it("does not trust mutable metadata when the order has no saved Checkout Session", async () => {
    order.stripePaymentIntentId = "";
    order.stripeSessionId = "";
    await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
      "no saved Checkout Session",
    );
    expect(mocks.retrieveCheckout).not.toHaveBeenCalled();
    expect(mongoose.connection.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { stripeLivemode: true },
    { currencySnapshot: "EUR" },
    { expectedAmountMinor: 9_999 },
  ])(
    "validates the stored purchase again inside the transaction: %j",
    async (mismatch) => {
      Object.assign(order, mismatch);
      await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
        "stored payment snapshot",
      );
      expect(mocks.tenantLock).toHaveBeenCalledWith(tenantId, session);
      expect(order.save).not.toHaveBeenCalled();
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );

  it("rechecks the PaymentIntent binding after acquiring the transaction lock", async () => {
    mocks.tenantLock.mockImplementationOnce(async () => {
      order.stripePaymentIntentId = "pi_different";
    });
    await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
      "stored payment snapshot",
    );
    expect(order.save).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("refuses to attach fallback metadata to an order already bound to a different PaymentIntent", async () => {
    order.stripePaymentIntentId = "pi_different";
    await expect(processVoucherRefundEvent(refundEvent())).rejects.toThrow(
      "PaymentIntent mismatch",
    );
    expect(mongoose.connection.transaction).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
  });
});

describe("failed or canceled voucher refunds", () => {
  it("preserves revoked codes and converted wallet value after a late refund failure", async () => {
    const revokedAt = new Date("2026-09-15T12:00:00Z");
    const redeemedAt = new Date("2026-09-01T12:00:00Z");
    coupons = [
      voucher({ revokedAt, isActive: false }),
      voucher({
        redeemedAt,
        redeemedBy: tenantId,
        remainingValueMinor: 0,
        isActive: false,
      }),
    ];
    order.refundState = "revoked";
    order.refundedAmountMinor = 10_000;
    expect(await processVoucherRefundEvent(failedRefundEvent())).toBe(true);
    expect(mocks.retrieveCharge).toHaveBeenCalledWith(
      "ch_voucher",
      {},
      { stripeAccount: accountId },
    );
    expect(order).toMatchObject({
      refundState: "manual_review",
      refundFailureReviewRequired: true,
      refundedAmountMinor: 10_000,
    });
    expect(order.refundReviewReason).toContain(
      "before restoring any voucher entitlement",
    );
    expect(coupons[0]).toMatchObject({
      revokedAt,
      isActive: false,
      remainingValueMinor: 10_000,
      refundReviewRequired: true,
    });
    expect(coupons[1]).toMatchObject({
      redeemedAt,
      redeemedBy: tenantId,
      isActive: false,
      remainingValueMinor: 0,
      refundReviewRequired: true,
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
    for (const coupon of coupons)
      expect(coupon.save).toHaveBeenCalledWith({ session });
    expect(order.save).toHaveBeenCalledWith({ session });
  });

  it("quarantines canceled refunds without automatically restoring entitlement", async () => {
    coupons[0].isActive = false;
    await processVoucherRefundEvent(
      failedRefundEvent({ status: "canceled" }, { type: "refund.updated" }),
    );
    expect(order).toMatchObject({
      refundState: "manual_review",
      refundFailureReviewRequired: true,
    });
    expect(coupons[0]).toMatchObject({
      isActive: false,
      remainingValueMinor: 10_000,
      refundReviewRequired: true,
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("does not repeat reconciliation when a failed refund event is retried", async () => {
    await processVoucherRefundEvent(failedRefundEvent());
    await processVoucherRefundEvent(failedRefundEvent());
    expect(order.processedRefundEventIds).toEqual(["evt_refund_failed"]);
    expect(mocks.couponFind).toHaveBeenCalledTimes(1);
    expect(coupons[0].save).toHaveBeenCalledTimes(1);
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  it("keeps failure review sticky across later and out-of-order charge refund events", async () => {
    await processVoucherRefundEvent(failedRefundEvent());
    const reason = order.refundReviewReason;
    await processVoucherRefundEvent(refundEvent());
    await processVoucherRefundEvent(
      refundEvent({ amount_refunded: 1_000 }, { id: "evt_old_partial" }),
    );
    expect(order).toMatchObject({
      refundState: "manual_review",
      refundFailureReviewRequired: true,
      refundReviewReason: reason,
      refundedAmountMinor: 10_000,
      processedRefundEventIds: [
        "evt_refund_failed",
        "evt_refund_1",
        "evt_old_partial",
      ],
    });
    expect(coupons[0]).toMatchObject({
      remainingValueMinor: 10_000,
      refundReviewRequired: true,
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each(["pending", "succeeded", "requires_action"])(
    "ignores refund.updated status %s",
    async (status) => {
      expect(
        await processVoucherRefundEvent(
          failedRefundEvent({ status }, { type: "refund.updated" }),
        ),
      ).toBe(false);
      expect(mocks.retrieveCharge).not.toHaveBeenCalled();
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    { payment_intent: "pi_other" },
    { currency: "eur" },
    { amount: 0 },
    { amount: 10_001 },
    { amount: 0.5 },
  ])(
    "rejects failed-refund identity or amount inconsistent with its charge: %j",
    async (mismatch) => {
      await expect(
        processVoucherRefundEvent(failedRefundEvent(mismatch)),
      ).rejects.toThrow("does not match its charge");
      expect(mocks.orderFindOne).not.toHaveBeenCalled();
      expect(mongoose.connection.transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects a retrieved charge with a different identity", async () => {
    mocks.retrieveCharge.mockResolvedValueOnce(
      refundEvent({ id: "ch_other" }).data.object,
    );
    await expect(
      processVoucherRefundEvent(failedRefundEvent()),
    ).rejects.toThrow("does not match its charge");
    expect(mocks.orderFindOne).not.toHaveBeenCalled();
    expect(mongoose.connection.transaction).not.toHaveBeenCalled();
  });
});

describe("late management refund provider failures", () => {
  it.each(["failed", "canceled"])(
    "invalidates the matching completed or in-flight management intent after %s",
    async (status) => {
      order.refundState = "revoked";
      order.refundedAmountMinor = 10000;
      await processVoucherRefundEvent(
        failedRefundEvent(
          { status },
          { type: status === "canceled" ? "refund.updated" : "refund.failed" },
        ),
      );
      expect(mocks.managementUpdate).toHaveBeenCalledWith(
        {
          _id: `voucher-refund:${tenantId}:${orderId}`,
          tenant: tenantId,
          couponOrder: orderId,
          accountId,
          paymentIntentId: intentId,
          stripeRefundId: "re_voucher",
        },
        {
          $set: {
            status: "review_required",
            reviewReason: order.refundReviewReason,
            nextAttemptAt: null,
            claimToken: "",
            claimExpiresAt: null,
          },
        },
        { session },
      );
      expect(order.refundFailureReviewRequired).toBe(true);
      expect(order.refundState).toBe("manual_review");
      expect(mocks.managementUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        order.save.mock.invocationCallOrder[0],
      );
    },
  );
  it("does not repeat intent invalidation for the same verified event", async () => {
    await processVoucherRefundEvent(failedRefundEvent());
    await processVoucherRefundEvent(failedRefundEvent());
    expect(mocks.managementUpdate).toHaveBeenCalledTimes(1);
  });
});
