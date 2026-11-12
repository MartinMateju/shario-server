import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: vi.fn(),
  coupons: vi.fn(),
  summary: vi.fn(),
  document: vi.fn(),
  resend: vi.fn(),
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { findOne: mocks.order },
  Coupon: { find: mocks.coupons },
}));
vi.mock("@/modules/coupon/voucher-delivery.service.js", () => ({
  getVoucherDeliverySummary: mocks.summary,
  getVoucherOrderDocument: mocks.document,
  requestVoucherCustomerResend: mocks.resend,
  getVoucherDocumentDescriptors: (order: any) =>
    Array.from({ length: order.quantity }, (_, index) => ({
      index,
      filename: `Voucher_${index + 1}.pdf`,
      contentType: "application/pdf",
    })),
}));

import { createVoucherPurchaseAccess } from "@/modules/coupon/voucher-order-access.js";
import { voucherPurchaseService } from "@/modules/coupon/voucher-purchase.service.js";

const tenantId = "507f1f77bcf86cd799439011";
const couponOrderId = "507f1f77bcf86cd799439012";
const couponId = "507f1f77bcf86cd799439013";
const chain = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  lean: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(value),
});
let order: any;
let accessToken: string;
const proof = () => ({ tenantId, couponOrderId, accessToken });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "ACCESS_TOKEN_SECRET",
    "voucher-tests-only-secret-with-at-least-32-bytes",
  );
  const access = createVoucherPurchaseAccess({ tenantId, couponOrderId });
  accessToken = access.accessToken;
  order = {
    _id: couponOrderId,
    tenant: tenantId,
    purchaseAccessTokenHash: access.purchaseAccessTokenHash,
    purchaseAccessExpiresAt: access.purchaseAccessExpiresAt,
    paidAt: new Date(),
    processedAt: new Date(),
    status: "processed_coupon",
    refundState: "none",
    refundedAmountMinor: 0,
    quantity: 1,
    coupons: [couponId],
    promoCodesSnapshot: ["SECRET-CODE"],
    productNameSnapshot: "The purchased design",
    currencySnapshot: "CZK",
    totalSnapshot: 1500,
    email: "buyer@studio.example",
    firstname: "Private",
    note: "Private gift message",
    processingError: "Secret provider error",
    expiresAtSnapshot: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  };
  mocks.order.mockImplementation(() => chain(order));
  mocks.coupons.mockImplementation(() =>
    chain([{ _id: couponId, promoCode: "SECRET-CODE", revokedAt: null }]),
  );
  mocks.summary.mockResolvedValue({
    customer: {
      status: "sent",
      generation: 0,
      sentAt: new Date(),
      nextAttemptAt: null,
    },
    admin: null,
  });
  mocks.document.mockResolvedValue({
    filename: "Voucher_1.pdf",
    content: Buffer.from("%PDF same code"),
    contentType: "application/pdf",
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("guest voucher purchase access", () => {
  it("requires the tenant and matching proof before reading delivery, codes or documents", async () => {
    const query = chain(null);
    mocks.order.mockReturnValue(query);
    await expect(
      voucherPurchaseService.status({
        ...proof(),
        tenantId: "507f1f77bcf86cd799439099",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "VOUCHER_PURCHASE_NOT_FOUND",
    });
    expect(mocks.order).toHaveBeenCalledWith({
      _id: couponOrderId,
      tenant: "507f1f77bcf86cd799439099",
    });
    expect(query.select).toHaveBeenCalledWith("+purchaseAccessTokenHash");
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.coupons).not.toHaveBeenCalled();
    expect(mocks.document).not.toHaveBeenCalled();
  });

  it.each(["status", "download", "resend"] as const)(
    "rejects invalid proof before %s side effects",
    async (method) => {
      await expect(
        voucherPurchaseService[method]({
          ...proof(),
          accessToken: "a".repeat(43),
          index: 0,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(mocks.summary).not.toHaveBeenCalled();
      expect(mocks.document).not.toHaveBeenCalled();
      expect(mocks.resend).not.toHaveBeenCalled();
    },
  );

  it("returns only a safe immutable purchase summary and never mistakes voucher expiry for checkout expiry", async () => {
    order.expiresAtSnapshot = new Date("2026-01-01");
    const status = await voucherPurchaseService.status(proof());
    expect(status).toMatchObject({
      status: "ready",
      paymentStatus: "paid",
      deliveryStatus: "sent",
      productName: "The purchased design",
      quantity: 1,
      currency: "CZK",
      total: 1500,
      maskedEmail: "b***@s***.example",
      voucherExpiresAt: "2026-01-01T00:00:00.000Z",
      voucherExpired: true,
      canResend: false,
    });
    expect(status.documents).toEqual([
      { index: 0, filename: "Voucher_1.pdf", contentType: "application/pdf" },
    ]);
    const serialized = JSON.stringify(status);
    for (const secret of [
      accessToken,
      order.purchaseAccessTokenHash,
      "SECRET-CODE",
      order.email,
      order.firstname,
      order.note,
      order.processingError,
    ])
      expect(serialized).not.toContain(secret);
    expect(mocks.coupons).toHaveBeenCalledWith({
      tenant: tenantId,
      order: couponOrderId,
    });
  });

  it.each([
    [
      { paidAt: null, status: "pending_coupon_payment" },
      "pending_payment",
      "pending",
    ],
    [{ paidAt: null, status: "expired_coupon_payment" }, "expired", "expired"],
    [
      { refundState: "revoked", refundedAmountMinor: 150000 },
      "refunded",
      "refunded",
    ],
    [
      { refundState: "manual_review", refundedAmountMinor: 50000 },
      "review_required",
      "review_required",
    ],
  ])(
    "withholds documents when payment is not safely deliverable: %s",
    async (fields, statusName, paymentStatus) => {
      Object.assign(order, fields);
      const status = await voucherPurchaseService.status(proof());
      expect(status).toMatchObject({
        status: statusName,
        paymentStatus,
        documents: [],
        canResend: false,
      });
      expect(mocks.coupons).not.toHaveBeenCalled();
    },
  );

  it("withholds documents for revoked codes and incomplete issuance", async () => {
    mocks.coupons.mockImplementation(() =>
      chain([{ _id: couponId, revokedAt: new Date() }]),
    );
    expect(await voucherPurchaseService.status(proof())).toMatchObject({
      status: "revoked",
      documents: [],
      canResend: false,
    });
    mocks.coupons.mockImplementation(() => chain([]));
    expect(await voucherPurchaseService.status(proof())).toMatchObject({
      status: "processing",
      documents: [],
      canResend: false,
    });
  });

  it("does not offer a PDF when persisted code references disagree with the purchase snapshot", async () => {
    mocks.coupons.mockImplementation(() =>
      chain([{ _id: couponId, promoCode: "OTHER-CODE", revokedAt: null }]),
    );
    expect(await voucherPurchaseService.status(proof())).toMatchObject({
      status: "processing",
      documents: [],
      canResend: false,
    });
  });

  it("shows historical documents but prevents email resend when a code has expired", async () => {
    mocks.coupons.mockImplementation(() =>
      chain([
        {
          _id: couponId,
          promoCode: "SECRET-CODE",
          revokedAt: null,
          expiresAt: new Date(Date.now() - 1000),
        },
      ]),
    );
    const status = await voucherPurchaseService.status(proof());
    expect(status).toMatchObject({
      status: "ready",
      paymentStatus: "paid",
      voucherExpired: true,
      canResend: false,
    });
    expect(status.documents).toHaveLength(1);
  });

  it("exposes resend cooldown without creating another delivery while automatic retry is pending", async () => {
    mocks.summary.mockResolvedValue({
      customer: {
        status: "failed",
        nextAttemptAt: new Date(Date.now() + 1000),
      },
      admin: null,
    });
    expect(await voucherPurchaseService.status(proof())).toMatchObject({
      canResend: false,
    });
    mocks.summary.mockResolvedValue({
      customer: { status: "ambiguous", nextAttemptAt: null },
      admin: null,
    });
    order.deliveryResendRequestedAt = new Date();
    let status = await voucherPurchaseService.status(proof());
    expect(status.canResend).toBe(false);
    expect(new Date(status.resendAvailableAt!).getTime()).toBe(
      order.deliveryResendRequestedAt.getTime() + 300000,
    );
    order.deliveryResendDay = new Date().toISOString().slice(0, 10);
    order.deliveryResendDayCount = 5;
    status = await voucherPurchaseService.status(proof());
    expect(status.canResend).toBe(false);
    const nextDay = new Date(`${order.deliveryResendDay}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    expect(status.resendAvailableAt).toBe(
      new Date(
        Math.max(
          nextDay.getTime(),
          order.deliveryResendRequestedAt.getTime() + 300000,
        ),
      ).toISOString(),
    );
  });

  it("delegates rendering and transactional resend using only the proven tenant and order", async () => {
    const pdf = await voucherPurchaseService.download({ ...proof(), index: 0 });
    expect(pdf.content.toString()).toBe("%PDF same code");
    expect(mocks.document).toHaveBeenCalledWith({
      tenantId,
      couponOrderId,
      index: 0,
    });
    await voucherPurchaseService.resend(proof());
    expect(mocks.resend).toHaveBeenCalledExactlyOnceWith({
      tenantId,
      couponOrderId,
    });
  });
});
