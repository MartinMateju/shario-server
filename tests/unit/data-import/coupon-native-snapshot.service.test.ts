import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repository: {
    acquireCouponOrderProcessingLock: vi.fn(),
    findCouponOrderByIdForTenant: vi.fn(),
    findProductByIdForTenant: vi.fn(),
    persistCouponOrderFulfillmentArtifacts: vi.fn(),
    markCouponOrderProcessed: vi.fn(),
    releaseCouponOrderProcessingLockWithError: vi.fn(),
    createCoupon: vi.fn(),
    createManualCouponOrder: vi.fn(),
    findCouponByIdForTenant: vi.fn(),
    findCouponForRedemption: vi.fn(),
    findCouponOrderValueSnapshot: vi.fn(),
    redeemCouponAtomically: vi.fn(),
    toObjectId: vi.fn((value: unknown) => value),
  },
  productFindOne: vi.fn(),
  incrementMoneyCredits: vi.fn(),
  getObjectBufferFromR2: vi.fn(),
  modifyPromoCodePdf: vi.fn(),
  orderFindOne: vi.fn(),
  couponFindOne: vi.fn(),
  tenantFindById: vi.fn(),
  appendLedger: vi.fn(),
  tenantLock: vi.fn(),
  enqueueDelivery: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getObjectBufferFromR2: mocks.getObjectBufferFromR2,
}));
vi.mock("@/infrastructure/pdf/pdf.utils.js", () => ({
  modifyPromoCodePdf: mocks.modifyPromoCodePdf,
}));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: { incrementMoneyCredits: mocks.incrementMoneyCredits },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  Product: { findOne: mocks.productFindOne },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: { findById: mocks.tenantFindById } }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { findOne: mocks.orderFindOne },
  Coupon: { findOne: mocks.couponFindOne },
}));
vi.mock("@/modules/coupon/voucher-lifecycle.service.js", () => ({ appendVoucherLedgerEntry: mocks.appendLedger }));
vi.mock("@/modules/coupon/voucher-delivery.service.js", () => ({ enqueueVoucherDelivery: mocks.enqueueDelivery }));
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({ acquireVoucherTenantMutationLock: mocks.tenantLock }));
vi.mock("@/modules/customer-notifications/index.js", () => ({ publishCustomerVoucherRedeemedNotificationSafely: vi.fn() }));
vi.mock("@/modules/coupon/coupon-email.service.js", () => ({
  couponEmailService: {
    sendAdminCouponOrderEmail: vi.fn(),
    sendCustomerCouponOrderEmail: vi.fn(),
  },
}));
vi.mock("@/modules/coupon/coupon.repository.js", () => ({
  couponRepository: mocks.repository,
}));
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({ requireReadyTenantConnectedAccount: vi.fn() }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getConnectedAccountRequestOptions: vi.fn(),
  getTenantPaymentStripe: vi.fn(),
}));
vi.mock("@/modules/checkout/checkout.session-persistence.js", () => ({
  attachStripeSessionOrExpire: vi.fn(),
}));
vi.mock("@/modules/checkout/checkout.urls.js", () => ({
  buildTenantCommerceUrl: vi.fn(),
  normalizeCommerceLocale: vi.fn(),
  resolveTenantCommerceOrigin: vi.fn(),
}));

import { couponService } from "@/modules/coupon/coupon.service.js";

const productQuery = (record: unknown) => {
  const query: any = { exec: () => Promise.resolve(record) };
  for (const method of ["select", "session", "lean"]) query[method] = () => query;
  return query;
};

describe("native Coupon issuance snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getObjectBufferFromR2.mockResolvedValue(Buffer.from("template"));
    mocks.modifyPromoCodePdf.mockResolvedValue(Buffer.from("voucher"));
    mocks.productFindOne.mockReturnValue(productQuery(null));
    mocks.orderFindOne.mockReturnValue(productQuery(null));
    mocks.tenantFindById.mockReturnValue(productQuery({ settings: { timezone: "UTC" } }));
    vi.spyOn(mongoose.connection, "transaction").mockImplementation(async (callback: any) => callback({ testTransaction: true }));
    mocks.repository.findCouponOrderValueSnapshot.mockResolvedValue(null);
    mocks.repository.redeemCouponAtomically.mockImplementation(
      async ({ couponId }: { couponId: unknown }) => ({
        _id: couponId,
        order: null,
      }),
    );
    mocks.incrementMoneyCredits.mockResolvedValue({ newBalance: 100 });
    vi.spyOn(mongoose, "startSession").mockResolvedValue({
      withTransaction: async (callback: () => Promise<void>) => callback(),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it("derives paid-order Coupon snapshots from the immutable CouponOrder", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const orderId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    const couponId = new mongoose.Types.ObjectId();
    const order = {
      _id: orderId,
      tenant: tenantId,
      product: productId,
      productNameSnapshot: "Gift card",
      quantity: 1,
      unitPriceSnapshot: 149.5,
      currencySnapshot: "EUR",
      voucherTemplateKeySnapshot: "voucher-template.pdf",
      paidAt: new Date(),
      isProcessing: true,
      processingStartedAt: new Date(),
      processingLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      processedStripeEventIds: [],
      emailSent: true,
      createdBy: null,
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.repository.acquireCouponOrderProcessingLock.mockResolvedValue(order);
    mocks.orderFindOne.mockReturnValue(productQuery(order));
    mocks.productFindOne.mockReturnValue(productQuery({
      _id: productId,
      name: "Gift card",
      type: "coupon",
      isActive: true,
      price: 999,
      currency: "CZK",
      voucherTemplate: "current-template.pdf",
    }));
    const createCoupons = vi
      .spyOn(couponService, "createCouponsForOrder")
      .mockResolvedValue({
        coupons: [couponId],
        promoCodes: ["NATIVE-ORDER-001"],
      });

    await expect(
      couponService.finalizePaidCouponOrder({
        tenantId,
        couponOrderId: String(orderId),
      }),
    ).resolves.toBe(true);

    expect(createCoupons).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        productId,
        couponOrderId: orderId,
        valueMinorSnapshot: 14_950,
        currencySnapshot: "EUR",
      }),
    );
    createCoupons.mockRestore();
  });

  it("derives manual Coupon snapshots from the validated Product value", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const productId = new mongoose.Types.ObjectId();
    const couponId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const save = vi.fn().mockResolvedValue(undefined);
    mocks.productFindOne.mockReturnValue(productQuery({
      _id: productId,
      name: "Gift card",
      type: "coupon",
      isActive: true,
      price: 75.25,
      currency: "EUR",
      voucherTemplate: "voucher-template.pdf",
    }));
    mocks.repository.createCoupon.mockResolvedValue({
      _id: couponId,
      promoCode: "NATIVE-MANUAL-001",
      order: null,
      save,
    });
    mocks.repository.createManualCouponOrder.mockResolvedValue({
      _id: orderId,
      unitPriceSnapshot: 75.25,
      currencySnapshot: "EUR",
    });
    mocks.repository.findCouponByIdForTenant.mockResolvedValue({
      _id: couponId,
    });

    await couponService.createManualPromoCode({
      tenantId,
      input: {
        productId: String(productId),
        email: "owner@example.com",
        note: "",
      },
    });

    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        productId,
        promoCode: expect.any(String),
        valueMinorSnapshot: 7_525,
        currencySnapshot: "EUR",
      }),
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it("redeems an immutable Coupon snapshot after its Product was deleted", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const couponId = new mongoose.Types.ObjectId();
    mocks.repository.findCouponForRedemption.mockResolvedValue({
      _id: couponId,
      product: new mongoose.Types.ObjectId(),
      promoCode: "SNAPSHOT-001",
      isActive: true,
      singleUse: true,
      redeemedAt: null,
      expiresAt: null,
      order: null,
      valueMinorSnapshot: 12_500,
      currencySnapshot: "CZK",
    });

    await expect(
      couponService.redeemPromoCode({
        tenantId,
        userId: new mongoose.Types.ObjectId().toString(),
        input: { promoCode: "SNAPSHOT-001" },
      }),
    ).resolves.toMatchObject({
      creditsAdded: 125,
      newBalance: 100,
      currency: "CZK",
    });

    expect(mocks.repository.redeemCouponAtomically).toHaveBeenCalledOnce();
    expect(mocks.incrementMoneyCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 125, currency: "CZK" }),
    );
  });

  it("redeems an authoritative CouponOrder snapshot after the Product kind changed", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    const couponId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    mocks.repository.findCouponForRedemption.mockResolvedValue({
      _id: couponId,
      product: new mongoose.Types.ObjectId(),
      promoCode: "ORDER-SNAPSHOT-001",
      isActive: true,
      singleUse: true,
      redeemedAt: null,
      expiresAt: null,
      order: orderId,
      valueMinorSnapshot: null,
      currencySnapshot: null,
    });
    mocks.productFindOne.mockReturnValue(
      productQuery({
        name: "Former voucher",
        type: "service",
        price: 999,
        currency: "CZK",
      }),
    );
    mocks.repository.findCouponOrderValueSnapshot.mockResolvedValue({
      unitPriceSnapshot: 49.5,
      currencySnapshot: "EUR",
    });

    await expect(
      couponService.redeemPromoCode({
        tenantId,
        userId: new mongoose.Types.ObjectId().toString(),
        input: { promoCode: "ORDER-SNAPSHOT-001" },
      }),
    ).resolves.toMatchObject({ creditsAdded: 49.5, currency: "EUR" });

    expect(mocks.incrementMoneyCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 49.5, currency: "EUR" }),
    );
  });

  it("still requires a valid Voucher product for the legacy Product fallback", async () => {
    const tenantId = new mongoose.Types.ObjectId().toString();
    mocks.repository.findCouponForRedemption.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      promoCode: "LEGACY-PRODUCT-001",
      isActive: true,
      singleUse: true,
      redeemedAt: null,
      expiresAt: null,
      order: null,
      valueMinorSnapshot: null,
      currencySnapshot: null,
    });
    mocks.productFindOne.mockReturnValue(
      productQuery({
        name: "Not a voucher",
        type: "service",
        price: 50,
        currency: "CZK",
      }),
    );

    await expect(
      couponService.redeemPromoCode({
        tenantId,
        userId: new mongoose.Types.ObjectId().toString(),
        input: { promoCode: "LEGACY-PRODUCT-001" },
      }),
    ).rejects.toThrow("Invalid coupon product type.");

    expect(mocks.repository.redeemCouponAtomically).not.toHaveBeenCalled();
    expect(mocks.incrementMoneyCredits).not.toHaveBeenCalled();
  });
});
