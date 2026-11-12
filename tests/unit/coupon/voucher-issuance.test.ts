import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repository: {
    toObjectId: vi.fn((value: unknown) => value), findProductByIdForTenant: vi.fn(),
    acquireCouponOrderProcessingLock: vi.fn(), findCouponOrderByIdForTenant: vi.fn(),
    setMissingCouponValueSnapshotsForOrder: vi.fn(), listCouponsForOrder: vi.fn(),
    createCoupon: vi.fn(), createManualCouponOrder: vi.fn(), findCouponByIdForTenant: vi.fn(),
    createCouponOrderFromCheckout: vi.fn(), attachStripeSession: vi.fn(),
    markCouponOrderCustomerEmailSent: vi.fn(), markCouponOrderAdminEmailSent: vi.fn(),
    markCouponOrderProcessed: vi.fn(), releaseCouponOrderProcessingLockWithError: vi.fn(),
  },
  orderFindOne: vi.fn(), orderUpdateOne: vi.fn(), couponFindOne: vi.fn(),
  productFindOne: vi.fn(), tenantFindById: vi.fn(), lockTenant: vi.fn(), ledger: vi.fn(),
  templateBuffer: vi.fn(), pdf: vi.fn(), customerEmail: vi.fn(), adminEmail: vi.fn(),
  designAssets: vi.fn(), designedPdf: vi.fn(), designedSvg: vi.fn(), enqueueDelivery: vi.fn(),
  stripeCreate: vi.fn(), stripeExpire: vi.fn(), readyAccount: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/modules/coupon/coupon.repository.js", () => ({ couponRepository: mocks.repository }));
vi.mock("@/modules/coupon/coupon.model.js", () => ({
  CouponOrder: { findOne: mocks.orderFindOne, updateOne: mocks.orderUpdateOne },
  Coupon: { findOne: mocks.couponFindOne },
}));
vi.mock("@/modules/product/product.model.js", () => ({ Product: { findOne: mocks.productFindOne } }));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: { findById: mocks.tenantFindById } }));
vi.mock("@/modules/product/voucher-offering.policy.js", () => ({ acquireVoucherTenantMutationLock: mocks.lockTenant }));
vi.mock("@/modules/coupon/voucher-lifecycle.service.js", () => ({ appendVoucherLedgerEntry: mocks.ledger }));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({ getObjectBufferFromR2: mocks.templateBuffer }));
vi.mock("@/infrastructure/pdf/pdf.utils.js", () => ({ modifyPromoCodePdf: mocks.pdf }));
vi.mock("@/modules/coupon/voucher-design.renderer.js", () => ({ renderVoucherPdf: mocks.designedPdf, renderVoucherSvg: mocks.designedSvg }));
vi.mock("@/modules/product/services/voucher-design.service.js", () => ({ resolveVoucherDesignAssets: mocks.designAssets }));
vi.mock("@/modules/coupon/voucher-delivery.service.js", () => ({ enqueueVoucherDelivery: mocks.enqueueDelivery }));
vi.mock("@/modules/coupon/voucher-physical-delivery.service.js", () => ({ voucherPhysicalDeliveryService: { dispatch: mocks.dispatch } }));
vi.mock("@/modules/coupon/voucher-order-access.js", () => ({ buildVoucherPurchaseAccessUrl: () => "https://example.shario.io/en/vouchers/purchase#accessToken=test-token" }));
vi.mock("@/modules/coupon/coupon-email.service.js", () => ({ couponEmailService: { sendCustomerCouponOrderEmail: mocks.customerEmail, sendAdminCouponOrderEmail: mocks.adminEmail } }));
vi.mock("@/modules/customer-notifications/index.js", () => ({ publishCustomerVoucherRedeemedNotificationSafely: vi.fn() }));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({ moneyCreditService: {} }));
vi.mock("@/modules/tenant-payments/services/tenant-payment-connect.service.js", () => ({ requireReadyTenantConnectedAccount: mocks.readyAccount }));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({ checkout: { sessions: { create: mocks.stripeCreate, expire: mocks.stripeExpire } } }),
  getConnectedAccountRequestOptions: (account: string, options = {}) => ({ stripeAccount: account, ...options }),
}));
vi.mock("@/modules/checkout/checkout.session-persistence.js", () => ({ attachStripeSessionOrExpire: async ({ attach }: any) => attach() }));
vi.mock("@/modules/checkout/checkout.urls.js", () => ({
  resolveTenantCommerceOrigin: () => "https://example.shario.io", normalizeCommerceLocale: (locale: string) => locale || "en",
  buildTenantCommerceUrl: ({ path }: any) => `https://example.shario.io/en/${path}`,
}));

import { couponService } from "@/modules/coupon/coupon.service.js";
import { DEFAULT_VOUCHER_DESIGN } from "@/modules/coupon/voucher-design.js";
import { couponCheckoutSchema } from "@/modules/coupon/coupon.validators.js";

const tenantId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const productId = new mongoose.Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
const orderId = new mongoose.Types.ObjectId("cccccccccccccccccccccccc");
const actorId = "dddddddddddddddddddddddd";
const transactionSession = { testSession: "issuance" };
const now = new Date("2026-09-15T10:00:00.000Z");
const defaultSettings = { version: 1, type: "value", validity: { mode: "months", months: 12 } };

const query = (record: unknown) => {
  const chain: any = { exec: vi.fn(async () => record) };
  for (const method of ["select", "session", "lean"]) chain[method] = vi.fn(() => chain);
  return chain;
};

const product = (overrides: Record<string, unknown> = {}) => ({
  _id: productId, tenant: tenantId, type: "coupon", isActive: true,
  name: "Current offering", price: 100, currency: "CZK", voucherTemplate: "current.pdf",
  ...overrides,
});

const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId, tenant: tenantId, product: productId, quantity: 1,
  productNameSnapshot: "Purchased gift", voucherTemplateKeySnapshot: "purchased.pdf",
  unitPriceSnapshot: 75, currencySnapshot: "EUR", expectedAmountMinor: 7_500,
  voucherSettingsSnapshot: defaultSettings, validityTimezoneSnapshot: "UTC",
  designSnapshot: { template: "original", backgroundColor: "#eeeeee" },
  paidAt: now, isProcessing: true, processingStartedAt: now, processingLeaseExpiresAt: new Date(now.getTime() + 300_000),
  processedAt: null, processedStripeEventIds: [], status: "pending_payment",
  refundState: "none", refundedAmountMinor: 0,
  createdBy: actorId, email: "buyer@example.test", note: "", coupons: [], promoCodesSnapshot: [],
  save: vi.fn(async () => undefined),
  ...overrides,
}) as any;

let persistedCoupons: any[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  persistedCoupons = [];
  vi.spyOn(mongoose.connection, "transaction").mockImplementation(async (callback: any) => callback(transactionSession));
  mocks.productFindOne.mockReturnValue(query(product()));
  mocks.repository.findProductByIdForTenant.mockResolvedValue(product());
  mocks.tenantFindById.mockReturnValue(query({ _id: tenantId, settings: { timezone: "UTC", publicDefaultLanguage: "en" } }));
  mocks.orderFindOne.mockReturnValue(query(null));
  mocks.couponFindOne.mockReturnValue(query(null));
  mocks.templateBuffer.mockResolvedValue(Buffer.from("original-template"));
  mocks.pdf.mockResolvedValue(Buffer.from("issued-pdf"));
  mocks.designedPdf.mockResolvedValue(Buffer.from("designed-issued-pdf"));
  mocks.designedSvg.mockResolvedValue("<svg></svg>");
  mocks.designAssets.mockResolvedValue({});
  mocks.customerEmail.mockResolvedValue(undefined);
  mocks.adminEmail.mockResolvedValue(true);
  mocks.enqueueDelivery.mockResolvedValue(undefined);
  mocks.repository.listCouponsForOrder.mockImplementation(async () => [...persistedCoupons]);
  mocks.repository.createCoupon.mockImplementation(async (input: any) => {
    const coupon = { ...input, _id: new mongoose.Types.ObjectId(), save: vi.fn(async () => undefined) };
    persistedCoupons.push(coupon);
    return coupon;
  });
  mocks.repository.findCouponByIdForTenant.mockImplementation(async (_tenant: string, id: unknown) => persistedCoupons.find((coupon) => String(coupon._id) === String(id)));
  mocks.repository.createManualCouponOrder.mockImplementation(async (input: any) => ({
    ...input, _id: orderId, product: input.product._id,
    unitPriceSnapshot: input.product.price, currencySnapshot: input.product.currency,
  }));
  mocks.readyAccount.mockResolvedValue({ stripeAccountId: "acct_tenant" });
  mocks.stripeCreate.mockResolvedValue({ id: "cs_new", url: "https://checkout.stripe.com/session", livemode: false });
});

const loadOrder = (order: any) => {
  mocks.orderFindOne.mockReturnValue(query(order));
  mocks.repository.acquireCouponOrderProcessingLock.mockResolvedValue(order);
};

describe("voucher issuance orchestration", () => {
  it("routes legacy shipped updates through guarded physical dispatch", async () => {
    const dispatched = { _id: orderId, status: "shipped_coupon" };
    mocks.dispatch.mockResolvedValueOnce(dispatched);
    await expect(couponService.updateCouponOrderStatus({
      tenantId, input: { couponOrderId: String(orderId), newStatus: "shipped_coupon" },
      admin: { id: actorId, email: "manager@example.test" },
    })).resolves.toMatchObject({ couponOrder: dispatched, newStatus: "shipped_coupon" });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      tenantId, couponOrderId: String(orderId), actorId, operationId: expect.any(String),
    });
  });

  it.each(["processed_coupon", "pending_coupon_payment", "expired_coupon_payment"] as const)(
    "does not permit a manual payment override or dispatch rollback to %s",
    async (newStatus) => {
      await expect(couponService.updateCouponOrderStatus({
        tenantId, input: { couponOrderId: String(orderId), newStatus },
        admin: { id: actorId, email: "manager@example.test" },
      })).rejects.toMatchObject({ code: "VOUCHER_ORDER_STATUS_MANAGED", statusCode: 409 });
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  const postalInput = () => couponCheckoutSchema.parse({
    productId: String(productId), email: "buyer@example.test", quantity: 3,
    sendPost: true, firstname: "Anna", lastname: "Novak",
    street: "Studio Street 1", city: "Brno", postalCode: "60200", countryCode: "cz",
  });

  it.each([undefined, { enabled: false, postageFeeMinor: 9000 }])(
    "rejects postal checkout without an enabled offering configuration: %j",
    async (physicalDelivery) => {
      mocks.productFindOne.mockReturnValue(query(product({
        voucherSettings: { ...defaultSettings, ...(physicalDelivery ? { physicalDelivery } : {}) },
      })));
      await expect(couponService.createCheckout(tenantId, postalInput()))
        .rejects.toMatchObject({ code: "VOUCHER_PHYSICAL_DELIVERY_UNAVAILABLE" });
      expect(mocks.repository.createCouponOrderFromCheckout).not.toHaveBeenCalled();
      expect(mocks.stripeCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { currency: "CZK", price: 100, feeMinor: 9000, fee: 90, unitMinor: 10000 },
    { currency: "EUR", price: 10.25, feeMinor: 425, fee: 4.25, unitMinor: 1025 },
    { currency: "JPY", price: 1000, feeMinor: 450, fee: 450, unitMinor: 1000 },
    { currency: "CZK", price: 100, feeMinor: 0, fee: 0, unitMinor: 10000 },
  ])("charges authoritative $currency postage once per order without changing the voucher price", async ({ currency, price, feeMinor, fee, unitMinor }) => {
    mocks.productFindOne.mockReturnValue(query(product({
      price, currency,
      voucherSettings: { ...defaultSettings, physicalDelivery: { enabled: true, postageFeeMinor: feeMinor } },
    })));
    mocks.repository.createCouponOrderFromCheckout.mockImplementationOnce(async (_tenant, input, offering, shippingFee) => ({
      _id: orderId, unitPriceSnapshot: offering.price,
      subtotalSnapshot: offering.price * input.quantity,
      totalSnapshot: offering.price * input.quantity + shippingFee,
      shippingFeeSnapshot: shippingFee, sendPost: input.sendPost,
    }));
    const result = await couponService.createCheckout(tenantId, postalInput());
    expect(mocks.repository.createCouponOrderFromCheckout).toHaveBeenCalledWith(
      tenantId, expect.objectContaining({ sendPost: true, countryCode: "CZ", quantity: 3 }),
      expect.objectContaining({ price }), fee,
      { connectedAccountId: "acct_tenant", expectedAmountMinor: unitMinor * 3 + feeMinor },
      expect.anything(),
    );
    const request = mocks.stripeCreate.mock.calls[0][0];
    expect(request.line_items[0]).toMatchObject({ quantity: 3, price_data: { currency: currency.toLowerCase(), unit_amount: unitMinor } });
    expect(request.line_items).toHaveLength(feeMinor > 0 ? 2 : 1);
    if (feeMinor > 0) expect(request.line_items[1]).toMatchObject({
      quantity: 1, price_data: { unit_amount: feeMinor, product_data: { metadata: { type: "coupon_shipping" } } },
    });
    expect(result).toMatchObject({ currency, total: price * 3 + fee, subtotal: price * 3, shippingFee: fee, sendPost: true });
  });

  it("does not charge configured postage for digital delivery", async () => {
    mocks.productFindOne.mockReturnValue(query(product({
      voucherSettings: { ...defaultSettings, physicalDelivery: { enabled: true, postageFeeMinor: 9000 } },
    })));
    mocks.repository.createCouponOrderFromCheckout.mockResolvedValueOnce({
      _id: orderId, unitPriceSnapshot: 100, totalSnapshot: 300,
      subtotalSnapshot: 300, shippingFeeSnapshot: 0, sendPost: false,
    });
    await couponService.createCheckout(tenantId, { ...postalInput(), sendPost: false });
    expect(mocks.repository.createCouponOrderFromCheckout.mock.calls[0][3]).toBe(0);
    expect(mocks.stripeCreate.mock.calls[0][0].line_items).toHaveLength(1);
    expect(mocks.stripeCreate.mock.calls[0][0].metadata.expectedAmountMinor).toBe("30000");
  });

  it("commits a purchased design and its delivery job after the offering was removed", async () => {
    const design = structuredClone(DEFAULT_VOUCHER_DESIGN);
    design.content.title = "Poukaz pro radost";
    const order = paidOrder({ designSnapshot: design, voucherTemplateKeySnapshot: "", validityTimezoneSnapshot: "Europe/Prague", localeSnapshot: "cs" });
    loadOrder(order);
    mocks.productFindOne.mockReturnValue(query(null));

    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) })).toBe(true);

    expect(mocks.productFindOne).not.toHaveBeenCalled();
    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(expect.objectContaining({ designSnapshot: design, session: transactionSession }));
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith({ tenantId, couponOrderId: String(orderId), session: transactionSession });
    expect(order.processedAt).toEqual(now);
    expect(order.save).toHaveBeenCalledWith({ session: transactionSession });
    expect(mocks.templateBuffer).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.designAssets).not.toHaveBeenCalled();
    expect(mocks.designedPdf).not.toHaveBeenCalled();
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(mocks.adminEmail).not.toHaveBeenCalled();
  });

  it("accepts a design-only offering for purchase and manual issuance while snapshotting its design", async () => {
    const design = structuredClone(DEFAULT_VOUCHER_DESIGN);
    mocks.productFindOne.mockReturnValue(query(product({ voucherTemplate: "", voucherDesign: design })));
    mocks.repository.createCouponOrderFromCheckout.mockResolvedValue({ _id: orderId, unitPriceSnapshot: 100, totalSnapshot: 100, shippingFeeSnapshot: 0 });
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "" };
    await couponService.createCheckout(tenantId, input);
    expect(mocks.repository.createCouponOrderFromCheckout.mock.calls[0][2].voucherDesign).toEqual(design);
    await couponService.createManualPromoCode({ tenantId, createdBy: actorId, input: { productId: String(productId), email: input.email, note: "Gift", operationId: "10ec5a82-08b8-4830-acce-3e678fe3e9cb" } });
    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(expect.objectContaining({ designSnapshot: design }));
    expect(mocks.repository.createManualCouponOrder).toHaveBeenCalledWith(expect.objectContaining({ designSnapshot: design, localeSnapshot: "en" }));
  });

  it("fails issuance when the delivery job cannot join the transaction", async () => {
    const order = paidOrder({ designSnapshot: structuredClone(DEFAULT_VOUCHER_DESIGN), voucherTemplateKeySnapshot: "" });
    loadOrder(order);
    mocks.enqueueDelivery.mockRejectedValueOnce(new Error("Outbox temporarily unavailable"));

    await expect(couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) })).rejects.toThrow("Outbox temporarily unavailable");

    expect(mocks.enqueueDelivery).toHaveBeenCalledWith({ tenantId, couponOrderId: String(orderId), session: transactionSession });
    expect(order.save).toHaveBeenCalledWith({ session: transactionSession });
    expect(order.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueueDelivery.mock.invocationCallOrder[0]);
    expect(mocks.repository.releaseCouponOrderProcessingLockWithError).toHaveBeenCalledWith(tenantId, String(orderId), "Outbox temporarily unavailable", now);
    expect(mocks.designedPdf).not.toHaveBeenCalled();
    expect(mocks.customerEmail).not.toHaveBeenCalled();
  });

  it.each(["archived", "deleted"])("fulfills a paid purchase using its saved terms when the offering is %s", async (state) => {
    const order = paidOrder();
    loadOrder(order);
    mocks.productFindOne.mockReturnValue(query(state === "deleted" ? null : product({ isActive: false, price: 999, voucherTemplate: "changed.pdf" })));

    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId), paidAt: now })).toBe(true);

    expect(mocks.productFindOne).not.toHaveBeenCalled();
    expect(mocks.templateBuffer).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith({ tenantId, couponOrderId: String(orderId), session: transactionSession });
    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, productId, couponOrderId: orderId, valueMinorSnapshot: 7_500, currencySnapshot: "EUR",
      expiresAt: new Date("2027-09-15T23:59:59.999Z"),
      voucherSettingsSnapshot: defaultSettings, designSnapshot: order.designSnapshot,
      productNameSnapshot: "Purchased gift", session: transactionSession,
    }));
    expect(mocks.lockTenant).toHaveBeenCalledWith(tenantId, transactionSession);
    expect(mocks.orderFindOne).toHaveBeenCalledWith({ _id: String(orderId), tenant: tenantId });
    expect(order.save).toHaveBeenCalledWith({ session: transactionSession });
    expect(mocks.ledger).toHaveBeenCalledWith(expect.objectContaining({ tenantId, kind: "issue", amountMinor: 7_500 }), transactionSession);
    expect(mocks.customerEmail).not.toHaveBeenCalled();
  });

  it("snapshots the 12-month default and tenant timezone before creating a Stripe checkout", async () => {
    mocks.tenantFindById.mockReturnValue(query({ _id: tenantId, settings: { timezone: "Europe/Prague", publicDefaultLanguage: "cs" } }));
    mocks.repository.createCouponOrderFromCheckout.mockResolvedValue({ _id: orderId, unitPriceSnapshot: 100, totalSnapshot: 100, shippingFeeSnapshot: 0 });
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "" };

    await couponService.createCheckout(tenantId, input);

    expect(mocks.repository.createCouponOrderFromCheckout).toHaveBeenCalledWith(
      tenantId, { ...input, giftMessage: "" },
      expect.objectContaining({ voucherSettings: defaultSettings }), 0,
      { connectedAccountId: "acct_tenant", expectedAmountMinor: 10_000 },
      { session: transactionSession, validityTimezoneSnapshot: "Europe/Prague", localeSnapshot: "cs", purchaseOriginSnapshot: "https://example.shario.io" },
    );
    expect(mocks.repository.createCouponOrderFromCheckout.mock.invocationCallOrder[0]).toBeLessThan(mocks.stripeCreate.mock.invocationCallOrder[0]);
    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
  });

  it.each(["Gift message has an unsupported glyph", "Gift message does not fit the voucher layout"])("rejects %s before creating an order or payment session", async (message) => {
    const offering = product({ voucherTemplate: "", voucherDesign: structuredClone(DEFAULT_VOUCHER_DESIGN) });
    mocks.repository.findProductByIdForTenant.mockResolvedValue(offering);
    mocks.productFindOne.mockReturnValue(query(offering));
    mocks.designedSvg.mockRejectedValueOnce(new Error(message));
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "", giftMessage: "A personal gift" };

    await expect(couponService.createCheckout(tenantId, input)).rejects.toThrow(message);

    expect(mocks.repository.createCouponOrderFromCheckout).not.toHaveBeenCalled();
    expect(mocks.stripeCreate).not.toHaveBeenCalled();
    expect(mocks.productFindOne).not.toHaveBeenCalled();
  });

  it("preflights a gift message and snapshots it without changing the tenant's design", async () => {
    const design = structuredClone(DEFAULT_VOUCHER_DESIGN);
    const originalMessage = design.content.message;
    const offering = product({ voucherTemplate: "", voucherDesign: design });
    mocks.repository.findProductByIdForTenant.mockResolvedValue(offering);
    mocks.productFindOne.mockReturnValue(query(offering));
    mocks.repository.createCouponOrderFromCheckout.mockResolvedValue({ _id: orderId, unitPriceSnapshot: 100, totalSnapshot: 100, shippingFeeSnapshot: 0 });
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "", giftMessage: "Všechno nejlepší, Anno!" };

    await couponService.createCheckout(tenantId, input);

    expect(mocks.designedSvg).toHaveBeenCalledWith(expect.objectContaining({ design, giftMessage: input.giftMessage, sample: true }));
    expect(mocks.repository.createCouponOrderFromCheckout.mock.calls[0][1].giftMessage).toBe(input.giftMessage);
    expect(mocks.repository.createCouponOrderFromCheckout.mock.calls[0][2].voucherDesign).toEqual(design);
    expect(design.content.message).toBe(originalMessage);
    expect(mocks.designedSvg.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.createCouponOrderFromCheckout.mock.invocationCallOrder[0]);
    expect(mocks.repository.createCouponOrderFromCheckout.mock.invocationCallOrder[0]).toBeLessThan(mocks.stripeCreate.mock.invocationCallOrder[0]);
  });

  it("requires another gift preflight when the offering design changes before the purchase transaction", async () => {
    const original = structuredClone(DEFAULT_VOUCHER_DESIGN);
    const changed = structuredClone(original);
    changed.content.title = "New voucher title";
    mocks.repository.findProductByIdForTenant.mockResolvedValue(product({ voucherTemplate: "", voucherDesign: original }));
    mocks.productFindOne.mockReturnValue(query(product({ voucherTemplate: "", voucherDesign: changed })));
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "", giftMessage: "A personal gift" };

    await expect(couponService.createCheckout(tenantId, input)).rejects.toMatchObject({ code: "VOUCHER_DESIGN_CHANGED" });

    expect(mocks.designedSvg).toHaveBeenCalledOnce();
    expect(mocks.repository.createCouponOrderFromCheckout).not.toHaveBeenCalled();
    expect(mocks.stripeCreate).not.toHaveBeenCalled();
  });

  it("rejects fixed-date checkout with less than 35 minutes remaining before creating an order or Stripe session", async () => {
    const expiry = new Date("2026-09-15T23:59:59.999Z");
    vi.setSystemTime(new Date(expiry.getTime() - 34 * 60 * 1000));
    mocks.productFindOne.mockReturnValue(query(product({
      voucherSettings: { version: 1, type: "value", validity: { mode: "date", date: "2026-09-15" } },
    })));
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "" };

    await expect(couponService.createCheckout(tenantId, input)).rejects.toMatchObject({ code: "VOUCHER_EXPIRY_TOO_CLOSE" });

    expect(mocks.repository.createCouponOrderFromCheckout).not.toHaveBeenCalled();
    expect(mocks.stripeCreate).not.toHaveBeenCalled();
    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
  });

  it("allows a fixed-date voucher with the full 35-minute payment margin remaining", async () => {
    const expiry = new Date("2026-09-15T23:59:59.999Z");
    vi.setSystemTime(new Date(expiry.getTime() - 35 * 60 * 1000));
    mocks.productFindOne.mockReturnValue(query(product({
      voucherSettings: { version: 1, type: "value", validity: { mode: "date", date: "2026-09-15" } },
    })));
    mocks.repository.createCouponOrderFromCheckout.mockResolvedValue({ _id: orderId, unitPriceSnapshot: 100, totalSnapshot: 100, shippingFeeSnapshot: 0 });
    const input = { productId: String(productId), email: "buyer@example.test", quantity: 1, sendPost: false, firstname: "", lastname: "", note: "", street: "", city: "", postalCode: "" };

    await expect(couponService.createCheckout(tenantId, input)).resolves.toMatchObject({ couponOrderId: orderId });

    expect(mocks.repository.createCouponOrderFromCheckout).toHaveBeenCalledOnce();
    expect(mocks.stripeCreate).toHaveBeenCalledOnce();
  });

  it("holds a payment arriving after fixed expiry for manual review without issuing or emailing a code", async () => {
    const paidAt = new Date("2026-09-16T00:01:00Z");
    const order = paidOrder({
      voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "date", date: "2026-09-15" } },
      paidAt,
    });
    loadOrder(order);

    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId), paidAt })).toBe(true);

    expect(order.refundState).toBe("manual_review");
    expect(order.refundReviewReason).toContain("Payment arrived after");
    expect(order.paidAt).toEqual(paidAt);
    expect(order.expiresAtSnapshot).toEqual(new Date("2026-09-15T23:59:59.999Z"));
    expect(order.isProcessing).toBe(false);
    expect(order.save).toHaveBeenCalledWith({ session: transactionSession });
    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.templateBuffer).not.toHaveBeenCalled();
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(mocks.adminEmail).not.toHaveBeenCalled();
    expect(mocks.repository.markCouponOrderProcessed).not.toHaveBeenCalled();
  });

  it("acknowledges payment replay without minting or enqueueing another voucher", async () => {
    const order = paidOrder();
    loadOrder(order);
    await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId), eventId: "evt_paid" });
    const originalCodes = [...order.promoCodesSnapshot];
    const originalExpiry = new Date(order.expiresAtSnapshot);
    mocks.repository.acquireCouponOrderProcessingLock.mockResolvedValue(null);
    mocks.repository.findCouponOrderByIdForTenant.mockResolvedValue(order);
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));

    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId), eventId: "evt_paid_replay" })).toBe(true);

    expect(order.paidAt).toEqual(now);
    expect(order.expiresAtSnapshot).toEqual(originalExpiry);
    expect(order.promoCodesSnapshot).toEqual(originalCodes);
    expect(mocks.repository.createCoupon).toHaveBeenCalledTimes(1);
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(mocks.adminEmail).not.toHaveBeenCalled();
  });

  it("does not claim customer or admin email delivery merely because issuance committed", async () => {
    const order = paidOrder({ emailSent: false, customerEmailSent: false, adminEmailSent: false, adminEmailSkipped: false });
    loadOrder(order);
    await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) });

    expect(order.emailSent).toBe(false);
    expect(order.customerEmailSent).toBe(false);
    expect(order.adminEmailSent).toBe(false);
    expect(order.adminEmailSkipped).toBe(false);
    expect(mocks.repository.markCouponOrderCustomerEmailSent).not.toHaveBeenCalled();
    expect(mocks.repository.markCouponOrderAdminEmailSent).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).toHaveBeenCalledOnce();
  });

  it("rejects issuance without a durably confirmed payment", async () => {
    const order = paidOrder({ paidAt: null });
    loadOrder(order);

    await expect(couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId), paidAt: now })).rejects.toThrow(/paid|payment/i);

    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("preserves perpetual historical purchases without silently assigning the new default expiry", async () => {
    const order = paidOrder({ voucherSettingsSnapshot: undefined, productNameSnapshot: "", voucherTemplateKeySnapshot: "", emailSent: true });
    loadOrder(order);
    mocks.productFindOne.mockReturnValue(query(product({ isActive: false })));
    await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) });
    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: undefined, voucherSettingsSnapshot: undefined }));
    expect(mocks.productFindOne).toHaveBeenCalledWith({ _id: productId, tenant: tenantId });
    expect(order.voucherTemplateKeySnapshot).toBe("current.pdf");
    expect(order.productNameSnapshot).toBe("Current offering");
    expect(mocks.templateBuffer).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).toHaveBeenCalledOnce();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("does not issue or deliver a voucher after its order was refunded", async () => {
    const order = paidOrder({ refundState: "revoked", refundedAmountMinor: 7_500 });
    loadOrder(order);
    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) })).toBe(true);
    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
    expect(mocks.templateBuffer).not.toHaveBeenCalled();
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(order.save).toHaveBeenCalledWith({ session: transactionSession });
  });

  it.each([
    { refundState: "manual_review", refundedAmountMinor: 0 },
    { refundState: "none", refundedAmountMinor: 500 },
  ])("does not enqueue an order awaiting refund reconciliation: %j", async (refund) => {
    const order = paidOrder(refund);
    loadOrder(order);

    expect(await couponService.finalizePaidCouponOrder({ tenantId, couponOrderId: String(orderId) })).toBe(true);

    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
    expect(mocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(mocks.customerEmail).not.toHaveBeenCalled();
    expect(mocks.adminEmail).not.toHaveBeenCalled();
  });

  it("issues a manual voucher, order and ledger in one transaction and reuses an identical operation", async () => {
    const input = { productId: String(productId), email: "buyer@example.test", note: "Reception sale", operationId: "manual-sale-001" };
    const first = await couponService.createManualPromoCode({ tenantId, createdBy: actorId, input });
    const savedCoupon = persistedCoupons[0];
    const savedOrder = await mocks.repository.createManualCouponOrder.mock.results[0].value;
    expect(mocks.repository.createCoupon).toHaveBeenCalledWith(expect.objectContaining({
      session: transactionSession, expiresAt: new Date("2027-09-15T23:59:59.999Z"), voucherSettingsSnapshot: defaultSettings,
    }));
    expect(mocks.repository.createManualCouponOrder).toHaveBeenCalledWith(expect.objectContaining({ session: transactionSession, issuanceOperationId: input.operationId }));
    expect(savedCoupon.save).toHaveBeenCalledWith({ session: transactionSession });
    expect(savedCoupon.order).toEqual(orderId);
    expect(mocks.ledger).toHaveBeenCalledWith(expect.objectContaining({ tenantId, kind: "issue", actorId, referenceId: String(orderId) }), transactionSession);
    mocks.orderFindOne.mockReturnValue(query(savedOrder));
    mocks.couponFindOne.mockReturnValue(query(savedCoupon));
    mocks.productFindOne.mockReturnValue(query(null));

    const repeated = await couponService.createManualPromoCode({ tenantId, createdBy: actorId, input });

    expect(repeated.promoCode).toBe(first.promoCode);
    expect(repeated.couponOrderId).toEqual(first.couponOrderId);
    expect(mocks.repository.createCoupon).toHaveBeenCalledTimes(1);
    expect(mocks.repository.createManualCouponOrder).toHaveBeenCalledTimes(1);
    expect(mocks.ledger).toHaveBeenCalledTimes(1);
    expect(mocks.orderFindOne).toHaveBeenLastCalledWith({ tenant: tenantId, issuanceOperationId: input.operationId });
    expect(mocks.couponFindOne).toHaveBeenCalledWith({ tenant: tenantId, order: orderId });
  });

  it("rejects reusing a manual issuance operation for another recipient", async () => {
    const input = { productId: String(productId), email: "buyer@example.test", note: "", operationId: "manual-sale-002" };
    mocks.orderFindOne.mockReturnValue(query({ _id: orderId, product: productId, email: "different@example.test", note: "", createdBy: actorId }));
    await expect(couponService.createManualPromoCode({ tenantId, createdBy: actorId, input })).rejects.toMatchObject({ code: "VOUCHER_OPERATION_CONFLICT" });
    expect(mocks.repository.createCoupon).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
});
