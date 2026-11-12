import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const provider = vi.hoisted(() => ({
  intent: vi.fn(),
  charge: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  refund: vi.fn(),
  account: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/modules/tenants/tenant.model.js", async () => {
  const { default: m } = await import("mongoose");
  const TenantModel =
    m.models.Tenant ||
    m.model("Tenant", new m.Schema({ voucherMutationVersion: Number }));
  return { default: TenantModel, TenantModel };
});
vi.mock(
  "@/modules/tenant-payments/tenant-payment-account.repository.js",
  () => ({ findTenantPaymentAccountByStripeAccount: provider.account }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    paymentIntents: { retrieve: provider.intent },
    charges: { retrieve: provider.charge },
    refunds: {
      list: provider.list,
      create: provider.create,
      retrieve: provider.refund,
    },
  }),
  getTenantPaymentStripeLivemode: () => false,
  getConnectedAccountRequestOptions: (stripeAccount: string, options = {}) => ({
    ...options,
    stripeAccount,
  }),
}));
import TenantModel from "@/modules/tenants/tenant.model.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger } from "@/modules/coupon/voucher-ledger.model.js";
import {
  VoucherManagementRefund,
  voucherManagementRefundId,
} from "@/modules/coupon/voucher-management-refund.model.js";
import {
  processVoucherManagementRefunds,
  requestVoucherPurchaseRefund,
} from "@/modules/coupon/voucher-management-refund.service.js";
import { reconcileVerifiedVoucherRefundCharge } from "@/modules/coupon/voucher-refund.service.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";

let repl: MongoMemoryReplSet;
const tenantId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
let order: any;
let coupon: any;
let charge: any;
let refund: any;
const input = () => ({
  tenantId: String(tenantId),
  couponOrderId: String(order._id),
  actorId: String(actorId),
  operationId: randomUUID(),
  reason: "Customer requested a full refund",
});
const requestId = () =>
  voucherManagementRefundId(String(tenantId), String(order._id));
const due = () =>
  VoucherManagementRefund.updateOne(
    { _id: requestId() },
    { $set: { nextAttemptAt: new Date(0) } },
  ).exec();

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([
    TenantModel.init(),
    Coupon.init(),
    CouponOrder.init(),
    VoucherLedger.init(),
    VoucherManagementRefund.init(),
  ]);
}, 60_000);
afterAll(async () => {
  await mongoose.disconnect();
  if (repl) await repl.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await Promise.all([
    TenantModel.collection.deleteMany({}),
    Coupon.collection.deleteMany({}),
    CouponOrder.collection.deleteMany({}),
    VoucherLedger.collection.deleteMany({}),
    VoucherManagementRefund.collection.deleteMany({}),
  ]);
  await TenantModel.collection.insertOne({
    _id: tenantId,
    voucherMutationVersion: 0,
  });
  const settings = {
    version: 1,
    type: "value",
    validity: { mode: "months", months: 12 },
  } as const;
  order = await CouponOrder.create({
    tenant: tenantId,
    product: productId,
    email: "buyer@example.test",
    quantity: 1,
    unitPriceSnapshot: 100,
    currencySnapshot: "CZK",
    expectedAmountMinor: 10000,
    totalSnapshot: 100,
    paidAt: new Date(),
    processedAt: new Date(),
    status: "processed_coupon",
    voucherSettingsSnapshot: settings,
    stripeConnectedAccountId: "acct_original",
    stripePaymentIntentId: "pi_original",
    stripeLivemode: false,
  });
  coupon = await Coupon.create({
    tenant: tenantId,
    product: productId,
    order: order._id,
    promoCode: "REFUND123",
    isActive: true,
    lifecycleVersion: 1,
    voucherTypeSnapshot: "value",
    voucherSettingsSnapshot: settings,
    valueMinorSnapshot: 10000,
    remainingValueMinor: 10000,
    currencySnapshot: "CZK",
  });
  order.coupons = [coupon._id];
  order.promoCodesSnapshot = [coupon.promoCode];
  await order.save();
  charge = {
    id: "ch_original",
    object: "charge",
    paid: true,
    livemode: false,
    currency: "czk",
    amount: 10000,
    amount_refunded: 0,
    payment_intent: "pi_original",
  };
  refund = {
    id: "re_original",
    object: "refund",
    currency: "czk",
    amount: 10000,
    payment_intent: "pi_original",
    status: "succeeded",
    metadata: { sharioVoucherRefundId: requestId() },
  };
  provider.account.mockResolvedValue({ tenant: tenantId });
  provider.intent.mockImplementation(async () => ({
    id: "pi_original",
    status: "succeeded",
    livemode: false,
    amount: 10000,
    currency: "czk",
    latest_charge: { ...charge },
  }));
  provider.charge.mockImplementation(async () => ({ ...charge }));
  provider.list.mockResolvedValue({ data: [], has_more: false });
  provider.create.mockImplementation(async () => {
    charge.amount_refunded = 10000;
    return refund;
  });
  provider.refund.mockImplementation(async () => refund);
});

describe("durable tenant voucher purchase refunds", () => {
  it("serializes concurrent requests and holds every code before a provider request", async () => {
    const results = await Promise.all([
      requestVoucherPurchaseRefund(input()),
      requestVoucherPurchaseRefund(input()),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await VoucherManagementRefund.countDocuments()).toBe(1);
    expect((await Coupon.findById(coupon._id))?.refundReviewRequired).toBe(
      true,
    );
    expect((await CouponOrder.findById(order._id))?.refundState).toBe(
      "manual_review",
    );
    expect(provider.create).not.toHaveBeenCalled();
    await expect(
      voucherLifecycleService.revoke({
        tenantId: String(tenantId),
        couponId: coupon._id,
        actorId: String(actorId),
        operationId: randomUUID(),
        reason: "Conflicting void",
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_RECONCILIATION_REQUIRED" });
  });

  it("rolls back the intent and hold if the order write fails", async () => {
    vi.spyOn(CouponOrder.prototype, "save").mockRejectedValueOnce(
      new Error("storage failure"),
    );
    await expect(requestVoucherPurchaseRefund(input())).rejects.toThrow(
      "storage failure",
    );
    expect(await VoucherManagementRefund.countDocuments()).toBe(0);
    expect((await Coupon.findById(coupon._id))?.refundReviewRequired).toBe(
      false,
    );
  });

  it("rejects foreign tenants and partially spent vouchers before any mutation", async () => {
    const otherTenant = new mongoose.Types.ObjectId();
    await TenantModel.collection.insertOne({
      _id: otherTenant,
      voucherMutationVersion: 0,
    });
    await expect(
      requestVoucherPurchaseRefund({
        ...input(),
        tenantId: String(otherTenant),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await Coupon.updateOne(
      { _id: coupon._id },
      { $set: { remainingValueMinor: 5000 } },
    );
    await expect(requestVoucherPurchaseRefund(input())).rejects.toMatchObject({
      code: "VOUCHER_REFUND_USED_VOUCHER",
    });
    expect(await VoucherManagementRefund.countDocuments()).toBe(0);
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(5000);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("refunds once and atomically revokes unused codes with ledger audit", async () => {
    await requestVoucherPurchaseRefund(input());
    await processVoucherManagementRefunds();
    await processVoucherManagementRefunds();
    await requestVoucherPurchaseRefund(input());
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_original", amount: 10000 }),
      { stripeAccount: "acct_original", idempotencyKey: requestId() },
    );
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "succeeded",
    );
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      isActive: false,
      refundReviewRequired: false,
      remainingValueMinor: 10000,
    });
    expect((await Coupon.findById(coupon._id))?.revokedAt).toBeTruthy();
    expect(
      await VoucherLedger.countDocuments({
        tenant: tenantId,
        coupon: coupon._id,
        kind: "revoke",
      }),
    ).toBe(1);
    expect(await CouponOrder.findById(order._id).lean()).toMatchObject({
      refundState: "revoked",
      refundedAmountMinor: 10000,
    });
  });

  it("recovers a provider-accepted refund after a network timeout without creating another", async () => {
    await requestVoucherPurchaseRefund(input());
    provider.create.mockImplementationOnce(async () => {
      charge.amount_refunded = 10000;
      throw new Error("response lost");
    });
    await processVoucherManagementRefunds();
    provider.list.mockResolvedValue({ data: [refund], has_more: false });
    await due();
    await processVoucherManagementRefunds();
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "succeeded",
    );
  });

  it("uses the same Stripe key inside the safe retry window", async () => {
    await requestVoucherPurchaseRefund(input());
    provider.create.mockRejectedValueOnce(new Error("connection failed"));
    await processVoucherManagementRefunds();
    await due();
    await processVoucherManagementRefunds();
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(
      provider.create.mock.calls.map((call) => call[1].idempotencyKey),
    ).toEqual([requestId(), requestId()]);
  });

  it("does not create a refund after the provider idempotency retry window", async () => {
    await requestVoucherPurchaseRefund(input());
    await VoucherManagementRefund.updateOne(
      { _id: requestId() },
      {
        $set: {
          firstProviderAttemptAt: new Date(Date.now() - 24 * 60 * 60_000),
        },
      },
    );
    await processVoucherManagementRefunds();
    expect(provider.create).not.toHaveBeenCalled();
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "review_required",
    );
    expect((await Coupon.findById(coupon._id))?.refundReviewRequired).toBe(
      true,
    );
  });

  it("holds an externally partially refunded purchase for review without refunding or confiscating value", async () => {
    await requestVoucherPurchaseRefund(input());
    charge.amount_refunded = 1000;
    provider.list.mockResolvedValue({
      data: [{ ...refund, id: "re_external", amount: 1000, metadata: {} }],
      has_more: false,
    });
    await processVoucherManagementRefunds();
    expect(provider.create).not.toHaveBeenCalled();
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "review_required",
    );
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 10000,
      isActive: true,
      refundReviewRequired: true,
    });
    expect(await VoucherLedger.countDocuments({ kind: "revoke" })).toBe(0);
  });

  it("polls an already-created pending refund by id without another creation", async () => {
    await requestVoucherPurchaseRefund(input());
    refund.status = "pending";
    provider.create.mockImplementationOnce(async () => refund);
    await processVoucherManagementRefunds();
    expect(
      (await VoucherManagementRefund.findById(requestId()))?.stripeRefundId,
    ).toBe("re_original");
    await due();
    refund.status = "succeeded";
    charge.amount_refunded = 10000;
    await processVoucherManagementRefunds();
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.refund).toHaveBeenCalledWith(
      "re_original",
      {},
      { stripeAccount: "acct_original" },
    );
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "succeeded",
    );
  });

  it("reopens a completed management refund for review after a late provider failure", async () => {
    await requestVoucherPurchaseRefund(input());
    await processVoucherManagementRefunds();
    expect((await VoucherManagementRefund.findById(requestId()))?.status).toBe(
      "succeeded",
    );
    await reconcileVerifiedVoucherRefundCharge({
      tenantId: String(tenantId),
      orderId: String(order._id),
      accountId: "acct_original",
      paymentIntentId: "pi_original",
      charge,
      eventId: "evt_late_failure",
      livemode: false,
      refund: { ...refund, status: "failed" },
    });
    expect(
      await VoucherManagementRefund.findById(requestId()).lean(),
    ).toMatchObject({
      status: "review_required",
      claimToken: "",
      claimExpiresAt: null,
      nextAttemptAt: null,
    });
    expect(await CouponOrder.findById(order._id).lean()).toMatchObject({
      refundState: "manual_review",
      refundFailureReviewRequired: true,
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      isActive: false,
      refundReviewRequired: true,
      remainingValueMinor: 10000,
    });
    await processVoucherManagementRefunds();
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it("prevents a stale provider-success response from overwriting a verified refund failure", async () => {
    await requestVoucherPurchaseRefund(input());
    let reachedProvider: () => void;
    let releaseProvider: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedProvider = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    provider.charge.mockImplementationOnce(async () => {
      const staleCharge = { ...charge };
      reachedProvider!();
      await release;
      return staleCharge;
    });
    const worker = processVoucherManagementRefunds();
    await reached;
    try {
      await reconcileVerifiedVoucherRefundCharge({
        tenantId: String(tenantId),
        orderId: String(order._id),
        accountId: "acct_original",
        paymentIntentId: "pi_original",
        charge,
        eventId: "evt_racing_failure",
        livemode: false,
        refund: { ...refund, status: "canceled" },
      });
    } finally {
      releaseProvider!();
    }
    await worker;
    expect(
      await VoucherManagementRefund.findById(requestId()).lean(),
    ).toMatchObject({
      status: "review_required",
      claimToken: "",
      nextAttemptAt: null,
    });
    expect(await CouponOrder.findById(order._id).lean()).toMatchObject({
      refundState: "manual_review",
      refundFailureReviewRequired: true,
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      isActive: true,
      refundReviewRequired: true,
      remainingValueMinor: 10000,
    });
    expect(await VoucherLedger.countDocuments({ kind: "revoke" })).toBe(0);
  });
});
