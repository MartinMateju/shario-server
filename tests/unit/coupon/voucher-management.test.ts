import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coupon: vi.fn(),
  ledger: vi.fn(),
  order: vi.fn(),
  download: vi.fn(),
  resend: vi.fn(),
}));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  Coupon: { findOne: mocks.coupon },
  CouponOrder: { findOne: mocks.order },
}));
vi.mock("@/modules/coupon/voucher-ledger.model.js", () => ({
  VoucherLedger: { find: mocks.ledger },
  VoucherReservation: {},
}));
vi.mock("@/modules/coupon/voucher-delivery.service.js", () => ({
  getVoucherDeliverySummary: vi.fn(),
  getVoucherDocumentDescriptors: vi.fn(),
  getVoucherOrderDocument: mocks.download,
  requestVoucherCustomerResend: mocks.resend,
}));
vi.mock("@/modules/coupon/voucher-management-refund.service.js", () => ({
  getVoucherManagementRefund: vi.fn(),
  requestVoucherPurchaseRefund: vi.fn(),
}));
import {
  issuedVoucherStatus,
  purchaseRefundBlocker,
} from "@/modules/coupon/voucher-management-policy.js";
import {
  voucherManagementDto,
  voucherManagementService,
} from "@/modules/coupon/voucher-management.service.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
const orderId = "cccccccccccccccccccccccc";
const voucher = (overrides = {}) => ({
  _id: id,
  tenant: tenantId,
  order: orderId,
  promoCode: "ABC12345",
  isActive: true,
  lifecycleVersion: 1,
  voucherTypeSnapshot: "value",
  valueMinorSnapshot: 10000,
  remainingValueMinor: 10000,
  currencySnapshot: "CZK",
  ...overrides,
});
const order = (overrides = {}) => ({
  _id: orderId,
  tenant: tenantId,
  paidAt: new Date(),
  processedAt: new Date(),
  stripeConnectedAccountId: "acct_original",
  stripePaymentIntentId: "pi_original",
  stripeLivemode: false,
  quantity: 1,
  coupons: [id],
  promoCodesSnapshot: ["ABC12345"],
  ...overrides,
});
const query = (record: unknown) => {
  const chain: any = { exec: vi.fn(async () => record) };
  for (const method of ["lean", "sort", "limit"])
    chain[method] = vi.fn(() => chain);
  return chain;
};
beforeEach(() => vi.clearAllMocks());

describe("issued voucher management policy", () => {
  it.each([
    [{}, "active"],
    [{ remainingValueMinor: 7500 }, "partially_redeemed"],
    [{ remainingValueMinor: 0 }, "redeemed"],
    [{ reservedValueMinor: 2500 }, "reserved"],
    [{ refundReviewRequired: true }, "review_required"],
    [{ revokedAt: new Date() }, "revoked"],
    [{ expiresAt: new Date("2000-01-01") }, "expired"],
    [
      {
        voucherTypeSnapshot: "experience",
        voucherSettingsSnapshot: { experienceQuantity: 2 },
        remainingQuantity: 1,
      },
      "partially_redeemed",
    ],
  ])("derives status from entitlement and holds: %j", (state, status) =>
    expect(issuedVoucherStatus(voucher(state))).toBe(status),
  );
  it.each([
    [{ remainingValueMinor: 5000 }, "used_voucher"],
    [{ redeemedBy: tenantId }, "used_voucher"],
    [{ reservedBy: tenantId }, "reserved_voucher"],
    [{ reservedValueMinor: 100 }, "reserved_voucher"],
    [{ refundReviewRequired: true }, "review_required"],
  ])("blocks automatic refund of used or held codes: %j", (state, blocker) => {
    expect(purchaseRefundBlocker(order(), [voucher(state)])).toBe(blocker);
    expect(voucherManagementDto(voucher(state)).canRevoke).toBe(false);
  });
  it("allows refunding an unused voided purchase but never a manual unpaid/platform order", () => {
    expect(
      purchaseRefundBlocker(order(), [
        voucher({ revokedAt: new Date(), isActive: false }),
      ]),
    ).toBeNull();
    expect(purchaseRefundBlocker(order({ paidAt: null }), [voucher()])).toBe(
      "not_paid",
    );
    expect(
      purchaseRefundBlocker(order({ stripeConnectedAccountId: "" }), [
        voucher(),
      ]),
    ).toBe("unsupported_payment");
    expect(
      purchaseRefundBlocker(order({ coupons: [tenantId] }), [voucher()]),
    ).toBe("inconsistent_codes");
  });
  it("keeps unknown historical balances null and exposes no order proof or design assets", () => {
    const dto = voucherManagementDto(
      voucher({
        lifecycleVersion: 0,
        remainingValueMinor: undefined,
        valueMinorSnapshot: undefined,
        purchaseAccessNonce: "secret",
        designSnapshot: { image: "private-key" },
      } as any),
    );
    expect(dto.remainingValueMinor).toBeNull();
    expect(dto.valueMinor).toBeNull();
    expect(JSON.stringify(dto)).not.toMatch(/secret|private-key/);
  });
});

describe("tenant-scoped management access", () => {
  it("scopes voucher and all ledger reads to the authenticated tenant", async () => {
    mocks.coupon.mockReturnValue(query(voucher()));
    mocks.ledger.mockReturnValue(
      query(
        Array.from({ length: 101 }, (_, index) => ({
          _id: `entry-${index}`,
          tenant: tenantId,
          kind: "commit",
          amountMinor: 1,
        })),
      ),
    );
    const result = await voucherManagementService.detail(tenantId, id);
    expect(mocks.coupon).toHaveBeenCalledWith({ _id: id, tenant: tenantId });
    expect(mocks.ledger).toHaveBeenCalledWith({ coupon: id, tenant: tenantId });
    expect(result.ledgerHasMore).toBe(true);
    expect(result.ledger).toHaveLength(100);
  });
  it("does not read ledger or render a PDF when tenant/order ownership fails", async () => {
    mocks.coupon.mockReturnValue(query(null));
    mocks.order.mockReturnValue(query(null));
    await expect(
      voucherManagementService.detail(tenantId, id),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      voucherManagementService.download(tenantId, orderId, 0),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      voucherManagementService.resend(tenantId, orderId),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.resend).not.toHaveBeenCalled();
  });
  it("downloads only the selected original document through the existing delivery checks", async () => {
    mocks.order.mockReturnValue(query(order()));
    mocks.download.mockResolvedValue({
      filename: "voucher.pdf",
      content: Buffer.from("pdf"),
    });
    await voucherManagementService.download(tenantId, orderId, 2);
    expect(mocks.download).toHaveBeenCalledWith({
      tenantId,
      couponOrderId: orderId,
      index: 2,
    });
  });
});
