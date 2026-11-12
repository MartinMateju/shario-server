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

// Keep real voucher, order, ledger, tenant-lock and outbox persistence. External
// transports stay inert: a verified payment transaction must not contact them.
const external = vi.hoisted(() => ({
  render: vi.fn(),
  storage: vi.fn(),
  email: vi.fn(),
  resolveSender: vi.fn(),
  postmark: vi.fn(),
  prepareCustomer: vi.fn(),
  prepareAdmin: vi.fn(),
}));
vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/modules/product/product.model.js", async () => {
  const { default: m } = await import("mongoose");
  const Product =
    m.models.Product ||
    m.model(
      "Product",
      new m.Schema({
        tenant: m.Schema.Types.ObjectId,
        name: String,
        voucherTemplate: String,
        price: Number,
        isActive: Boolean,
        isArchived: Boolean,
      }),
    );
  return { default: Product, Product };
});
vi.mock("@/modules/tenants/tenant.model.js", async () => {
  const { default: m } = await import("mongoose");
  const TenantModel =
    m.models.Tenant ||
    m.model("Tenant", new m.Schema({ voucherMutationVersion: Number }));
  return { default: TenantModel, TenantModel };
});
vi.mock("@/modules/user/user.model.js", () => ({ default: {} }));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  getObjectBufferFromR2: external.storage,
}));
vi.mock("@/infrastructure/pdf/pdf.utils.js", () => ({
  modifyPromoCodePdf: external.render,
}));
vi.mock("@/modules/coupon/voucher-design.renderer.js", () => ({
  renderVoucherPdf: external.render,
  renderVoucherSvg: external.render,
}));
vi.mock("@/modules/product/services/voucher-design.service.js", () => ({
  resolveVoucherDesignAssets: external.storage,
}));
vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: external.email,
}));
vi.mock(
  "@/modules/registered-sender-email/services/managed-sender-resolver.service.js",
  () => ({ resolveManagedSender: external.resolveSender }),
);
vi.mock("@/infrastructure/email/postmark.client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/infrastructure/email/postmark.client.js")
  >()),
  sendPostmarkEmail: external.postmark,
}));
vi.mock("@/modules/coupon/coupon-email.service.js", () => ({
  VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES: 6 * 1024 * 1024,
  couponEmailService: {
    sendCustomerCouponOrderEmail: external.email,
    sendAdminCouponOrderEmail: external.email,
    prepareCustomerCouponOrderEmail: external.prepareCustomer,
    prepareAdminCouponOrderEmail: external.prepareAdmin,
  },
}));
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerVoucherRedeemedNotificationSafely: vi.fn(),
}));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: {},
}));
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({ requireReadyTenantConnectedAccount: vi.fn() }),
);
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: vi.fn(),
  getConnectedAccountRequestOptions: vi.fn(),
}));

import TenantModel from "@/modules/tenants/tenant.model.js";
import Product from "@/modules/product/product.model.js";
import { logger } from "@/config/logger.js";
import { Coupon, CouponOrder } from "@/modules/coupon/coupon.model.js";
import { COUPON_STATUS } from "@/modules/coupon/coupon.constants.js";
import { couponService } from "@/modules/coupon/coupon.service.js";
import { couponRepository } from "@/modules/coupon/coupon.repository.js";
import { VoucherLedger } from "@/modules/coupon/voucher-ledger.model.js";
import { VoucherDeliveryModel } from "@/modules/coupon/voucher-delivery.model.js";
import * as delivery from "@/modules/coupon/voucher-delivery.service.js";
import { couponCheckoutSchema } from "@/modules/coupon/coupon.validators.js";

let replicaSet: MongoMemoryReplSet;
const tenantId = new mongoose.Types.ObjectId();
const otherTenantId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const paidAt = new Date();

const purchasedOrder = (overrides: Record<string, unknown> = {}) =>
  CouponOrder.create({
    tenant: tenantId,
    product: productId,
    productNameSnapshot: "Purchased voucher",
    voucherTemplateKeySnapshot: "retained-purchased-template.pdf",
    voucherSettingsSnapshot: {
      version: 1,
      type: "value",
      validity: { mode: "months", months: 12 },
    },
    validityTimezoneSnapshot: "UTC",
    localeSnapshot: "en",
    quantity: 2,
    unitPriceSnapshot: 50,
    currencySnapshot: "CZK",
    expectedAmountMinor: 10_000,
    totalSnapshot: 100,
    email: "buyer@example.test",
    stripeSessionId: "cs_paid_purchase",
    stripeConnectedAccountId: "acct_tenant",
    stripeLivemode: false,
    paidAt,
    ...overrides,
  });

const configureManagedDelivery = async () => {
  const managed = await vi.importActual<
    typeof import("@/infrastructure/email/managed-email.service.js")
  >("@/infrastructure/email/managed-email.service.js");
  external.storage.mockResolvedValue(Buffer.from("retained-template"));
  external.render.mockResolvedValue(Buffer.from("%PDF-1.7 voucher-test"));
  external.prepareCustomer.mockImplementation(
    async ({ order: purchase, attachments }) => ({
      tenantId: String(purchase.tenant),
      orderId: String(purchase._id),
      to: purchase.email,
      subject: "Your purchased vouchers",
      html: "<p>Your vouchers are attached.</p>",
      attachments,
    }),
  );
  external.prepareAdmin.mockImplementation(async ({ order: purchase }) => ({
    tenantId: String(purchase.tenant),
    orderId: String(purchase._id),
    to: "studio-admin@example.test",
    subject: "Voucher purchase",
    html: "<p>A voucher purchase was paid.</p>",
  }));
  external.resolveSender.mockResolvedValue({
    id: "eeeeeeeeeeeeeeeeeeeeeeee",
    displayName: "Voucher studio",
    fromEmail: "voucher-studio@notify.shario.io",
    replyToEmail: "studio@example.test",
    postmarkServerToken: "test-server-token",
  });
  external.email.mockImplementation(managed.sendManagedTenantEmail);
  external.postmark.mockImplementation(async ({ metadata, headers }) => {
    const { deliveryId } = metadata;
    expect(deliveryId).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata).not.toHaveProperty("messageId");
    for (const value of Object.values(metadata)) {
      expect(String(value).length).toBeLessThanOrEqual(80);
    }
    expect(headers).toContainEqual({
      Name: "Message-ID",
      Value: `<voucher.${deliveryId}@shario.io>`,
    });
    const fenced = await VoucherDeliveryModel.findById(deliveryId)
      .select("+claimToken")
      .lean();
    expect(fenced).toMatchObject({
      status: "sending",
      providerAttemptStartedAt: expect.any(Date),
      claimExpiresAt: expect.any(Date),
    });
    expect(fenced?.claimToken).not.toBe("");
    return {
      provider: "postmark",
      status: "sent",
      providerMessageId: `postmark-${deliveryId}`,
    };
  });
};

describe("voucher purchase and delivery atomic persistence", () => {
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await Promise.all([
      TenantModel.init(),
      Product.init(),
      Coupon.init(),
      CouponOrder.init(),
      VoucherLedger.init(),
      VoucherDeliveryModel.init(),
    ]);
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all([
      TenantModel.collection.deleteMany({}),
      Product.collection.deleteMany({}),
      Coupon.collection.deleteMany({}),
      CouponOrder.collection.deleteMany({}),
      VoucherLedger.collection.deleteMany({}),
      VoucherDeliveryModel.collection.deleteMany({}),
    ]);
    await TenantModel.collection.insertOne({
      _id: tenantId,
      voucherMutationVersion: 0,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (replicaSet) await replicaSet.stop();
  });

  it.each([
    { currency: "CZK", unitPrice: 50, unitMinor: 5000, shippingFee: 90, feeMinor: 9000 },
    { currency: "JPY", unitPrice: 1000, unitMinor: 1000, shippingFee: 450, feeMinor: 450 },
  ])("persists physical $currency terms, verifies postage, and queues the same digital vouchers exactly once", async ({ currency, unitPrice, unitMinor, shippingFee, feeMinor }) => {
    const quantity = 3;
    const expectedAmountMinor = unitMinor * quantity + feeMinor;
    const input = couponCheckoutSchema.parse({
      productId: String(productId), email: "buyer@example.test", quantity, sendPost: true,
      firstname: "Anna", lastname: "Novak", street: "Studio Street 1",
      city: "Brno", postalCode: "60200", countryCode: "cz",
    });
    const order = await couponRepository.createCouponOrderFromCheckout(
      String(tenantId), input,
      {
        _id: productId, name: "Posted voucher", price: unitPrice, currency,
        voucherTemplate: "purchased-postal.pdf",
        voucherSettings: {
          version: 1, type: "value", validity: { mode: "months", months: 12 },
          physicalDelivery: { enabled: true, postageFeeMinor: feeMinor },
        },
      },
      shippingFee, { connectedAccountId: "acct_tenant", expectedAmountMinor },
      { validityTimezoneSnapshot: "UTC", localeSnapshot: "en" },
    );
    await couponRepository.attachStripeSession({
      tenantId: String(tenantId), couponOrderId: String(order._id),
      connectedAccountId: "acct_tenant", sessionId: "cs_postal", livemode: false,
    });
    const saved = await CouponOrder.findById(order._id).lean();
    expect(saved).toMatchObject({
      sendPost: true, firstname: "Anna", countryCode: "CZ",
      unitPriceSnapshot: unitPrice, shippingFeeSnapshot: shippingFee,
      subtotalSnapshot: unitPrice * quantity, totalSnapshot: unitPrice * quantity + shippingFee,
      expectedAmountMinor,
    });
    const payment = {
      tenantId: String(tenantId), connectedAccountId: "acct_tenant", eventId: "evt_postal",
      livemode: false, paidAt,
      session: {
        id: "cs_postal", client_reference_id: `CO_${order._id}`,
        status: "complete", payment_status: "paid", payment_intent: "pi_postal",
        amount_total: expectedAmountMinor, currency: currency.toLowerCase(), livemode: false,
        metadata: { tenantId: String(tenantId), couponOrderId: String(order._id) },
      } as never,
    };
    await expect(couponService.processCouponOrderFromWebhook({
      ...payment,
      session: { ...(payment.session as object), amount_total: unitMinor * quantity } as never,
    })).rejects.toThrow("amount mismatch");
    expect(await Coupon.countDocuments()).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(0);
    await expect(couponService.processCouponOrderFromWebhook(payment)).resolves.toBe(true);
    await expect(couponService.processCouponOrderFromWebhook(payment)).resolves.toBe(true);
    const coupons = await Coupon.find({ order: order._id }).lean();
    expect(coupons).toHaveLength(quantity);
    expect(coupons.every(coupon => coupon.valueMinorSnapshot === unitMinor && coupon.remainingValueMinor === unitMinor)).toBe(true);
    expect((await VoucherLedger.find({ kind: "issue" }).lean()).map(row => row.amountMinor))
      .toEqual(Array(quantity).fill(unitMinor));
    const jobs = await VoucherDeliveryModel.find({ couponOrder: order._id }).lean();
    expect(jobs.map(job => job.channel).sort()).toEqual(["admin", "customer"]);
    expect(jobs.every(job => job.status === "pending")).toBe(true);
    expect(external.email).not.toHaveBeenCalled();
    expect(external.render).not.toHaveBeenCalled();
  });

  it("rolls back issued codes, ledger and delivery jobs together, then recovers the confirmed payment", async () => {
    const order = await purchasedOrder();
    const enqueue = delivery.enqueueVoucherDelivery;
    const intercepted = vi
      .spyOn(delivery, "enqueueVoucherDelivery")
      .mockImplementationOnce(async (params) => {
        await enqueue(params);
        throw new Error("Simulated transaction failure after outbox insertion");
      });
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
      sessionId: order.stripeSessionId,
      eventId: "evt_paid",
    };

    await expect(couponService.finalizePaidCouponOrder(input)).rejects.toThrow(
      "Simulated transaction failure after outbox insertion",
    );

    expect(await Coupon.countDocuments()).toBe(0);
    expect(await VoucherLedger.countDocuments()).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(0);
    const failed = await CouponOrder.findById(order._id);
    expect(failed?.paidAt).toEqual(paidAt);
    expect(failed?.processedAt).toBeNull();
    expect(failed?.status).toBe(COUPON_STATUS.PENDING_PAYMENT);
    expect(failed?.coupons).toHaveLength(0);
    expect(failed?.promoCodesSnapshot).toHaveLength(0);
    expect(failed?.isProcessing).toBe(false);
    intercepted.mockRestore();

    expect(await couponService.finalizePaidCouponOrder(input)).toBe(true);

    expect(await Coupon.countDocuments()).toBe(2);
    expect(await VoucherLedger.countDocuments({ kind: "issue" })).toBe(2);
    const jobs = await VoucherDeliveryModel.find({
      tenant: tenantId,
      couponOrder: order._id,
    }).lean();
    expect(jobs.map((job) => job.channel).sort()).toEqual([
      "admin",
      "customer",
    ]);
    expect(jobs.every((job) => job.status === "pending")).toBe(true);
    const issued = await CouponOrder.findById(order._id);
    expect(issued?.paidAt).toEqual(paidAt);
    expect(issued?.status).toBe(COUPON_STATUS.PROCESSED);
    expect(issued?.processedAt).toBeInstanceOf(Date);
    expect(issued?.customerEmailSent).toBe(false);
    expect(issued?.adminEmailSent).toBe(false);
    expect(external.render).not.toHaveBeenCalled();
    expect(external.storage).not.toHaveBeenCalled();
    expect(external.email).not.toHaveBeenCalled();
  });

  it("acknowledges repeated verified events without issuing new codes or delivery intents", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
      sessionId: order.stripeSessionId,
      eventId: "evt_paid",
    };
    expect(await couponService.finalizePaidCouponOrder(input)).toBe(true);
    const first = await CouponOrder.findById(order._id).lean();
    const firstJobIds = (await VoucherDeliveryModel.find().lean())
      .map((job) => job._id)
      .sort();

    expect(await couponService.finalizePaidCouponOrder(input)).toBe(true);
    expect(
      await couponService.finalizePaidCouponOrder({
        ...input,
        eventId: "evt_duplicate_payment",
      }),
    ).toBe(true);

    const repeated = await CouponOrder.findById(order._id).lean();
    expect(repeated?.promoCodesSnapshot).toEqual(first?.promoCodesSnapshot);
    expect(repeated?.expiresAtSnapshot).toEqual(first?.expiresAtSnapshot);
    expect(repeated?.paidAt).toEqual(first?.paidAt);
    expect(await Coupon.countDocuments()).toBe(2);
    expect(await VoucherLedger.countDocuments({ kind: "issue" })).toBe(2);
    expect(
      (await VoucherDeliveryModel.find().lean()).map((job) => job._id).sort(),
    ).toEqual(firstJobIds);
    expect(external.email).not.toHaveBeenCalled();
  });

  it("cannot issue another tenant's paid order through a matching order id", async () => {
    const order = await purchasedOrder();

    expect(
      await couponService.finalizePaidCouponOrder({
        tenantId: String(otherTenantId),
        couponOrderId: String(order._id),
      }),
    ).toBe(false);

    expect(await Coupon.countDocuments()).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(0);
    expect((await CouponOrder.findById(order._id))?.paidAt).toEqual(paidAt);
  });

  it("serializes concurrent duplicate events into one set of codes and jobs", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
      sessionId: order.stripeSessionId,
      eventId: "evt_concurrent_paid",
    };

    const results = await Promise.all([
      couponService.finalizePaidCouponOrder(input),
      couponService.finalizePaidCouponOrder(input),
    ]);

    expect(results).toContain(true);
    // A caller that encountered the live issuance lease can safely retry.
    expect(await couponService.finalizePaidCouponOrder(input)).toBe(true);
    expect(await Coupon.countDocuments()).toBe(2);
    expect(await VoucherLedger.countDocuments({ kind: "issue" })).toBe(2);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(2);
    expect(
      (await CouponOrder.findById(order._id))?.promoCodesSnapshot,
    ).toHaveLength(2);
  });

  it("does not turn an unconfirmed checkout into a paid voucher from a caller-supplied date", async () => {
    const order = await purchasedOrder({ paidAt: null });

    expect(
      await couponService.finalizePaidCouponOrder({
        tenantId: String(tenantId),
        couponOrderId: String(order._id),
        paidAt,
      }),
    ).toBe(false);

    expect((await CouponOrder.findById(order._id))?.paidAt).toBeNull();
    expect(await Coupon.countDocuments()).toBe(0);
    expect(await VoucherLedger.countDocuments()).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(0);
  });

  it("records the first verified payment time once and rejects a different payment intent on replay", async () => {
    const order = await purchasedOrder({ paidAt: null });
    const confirmation = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
      sessionId: order.stripeSessionId,
      paymentIntentId: "pi_original_purchase",
      paidAt,
    };
    await couponRepository.recordConfirmedCouponPayment(confirmation);
    await couponRepository.recordConfirmedCouponPayment({
      ...confirmation,
      paidAt: new Date(paidAt.getTime() + 16 * 24 * 60 * 60_000),
    });

    await expect(
      couponRepository.recordConfirmedCouponPayment({
        ...confirmation,
        paymentIntentId: "pi_different_purchase",
      }),
    ).rejects.toThrow("snapshot changed");
    await expect(
      couponRepository.recordConfirmedCouponPayment({
        ...confirmation,
        tenantId: String(otherTenantId),
      }),
    ).rejects.toThrow("snapshot changed");

    const confirmed = await CouponOrder.findById(order._id);
    expect(confirmed?.paidAt).toEqual(paidAt);
    expect(confirmed?.stripePaymentIntentId).toBe("pi_original_purchase");
    expect(await Coupon.countDocuments()).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(0);
  });

  it("keeps deterministic delivery intents when enqueue is repeated in later transactions", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
    };
    await couponService.finalizePaidCouponOrder(input);
    const originalIds = (await VoucherDeliveryModel.find().lean())
      .map((job) => job._id)
      .sort();

    await mongoose.connection.transaction(async (session) => {
      await delivery.enqueueVoucherDelivery({ ...input, session });
      await delivery.enqueueVoucherDelivery({ ...input, session });
    });

    expect(
      (await VoucherDeliveryModel.find().lean()).map((job) => job._id).sort(),
    ).toEqual(originalIds);
    expect(await VoucherDeliveryModel.countDocuments({ generation: 0 })).toBe(
      2,
    );
  });

  it("allows only one customer resend when two requests arrive together", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
    };
    await couponService.finalizePaidCouponOrder(input);
    await VoucherDeliveryModel.updateOne(
      { couponOrder: order._id, channel: "customer" },
      { $set: { status: "sent", nextAttemptAt: null, sentAt: new Date() } },
    );

    const results = await Promise.allSettled([
      delivery.requestVoucherCustomerResend(input),
      delivery.requestVoucherCustomerResend(input),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "VOUCHER_DELIVERY_PENDING" });
    expect(
      await VoucherDeliveryModel.countDocuments({
        couponOrder: order._id,
        channel: "customer",
        generation: 1,
      }),
    ).toBe(1);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(3);
    const updated = await CouponOrder.findById(order._id);
    expect(updated?.deliveryResendGeneration).toBe(1);
    expect(updated?.deliveryResendDayCount).toBe(1);
    expect(await Coupon.countDocuments()).toBe(2);
    expect(external.email).not.toHaveBeenCalled();
  });

  it("rolls back resend counters if the new customer delivery intent cannot be persisted", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
    };
    await couponService.finalizePaidCouponOrder(input);
    await VoucherDeliveryModel.updateOne(
      { couponOrder: order._id, channel: "customer" },
      { $set: { status: "sent", nextAttemptAt: null, sentAt: new Date() } },
    );
    const write = vi
      .spyOn(VoucherDeliveryModel.collection, "updateOne")
      .mockRejectedValueOnce(new Error("Delivery intent storage failed"));

    await expect(delivery.requestVoucherCustomerResend(input)).rejects.toThrow(
      "Delivery intent storage failed",
    );

    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
    const failed = await CouponOrder.findById(order._id);
    expect(failed?.deliveryResendGeneration).toBe(0);
    expect(failed?.deliveryResendRequestedAt).toBeNull();
    expect(failed?.deliveryResendDayCount).toBe(0);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(2);
    expect(await VoucherDeliveryModel.countDocuments({ generation: 1 })).toBe(
      0,
    );

    await delivery.requestVoucherCustomerResend(input);

    expect(
      (await CouponOrder.findById(order._id))?.deliveryResendGeneration,
    ).toBe(1);
    expect(await VoucherDeliveryModel.countDocuments({ generation: 1 })).toBe(
      1,
    );
  });

  it("commits successful customer and admin provider outcomes with their order delivery flags", async () => {
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
    };
    await couponService.finalizePaidCouponOrder(input);
    await configureManagedDelivery();

    const outcome = await delivery.processVoucherDeliveryOutbox({ limit: 5 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(outcome).toEqual({ processed: 2, sent: 2 });

    const jobs = await VoucherDeliveryModel.find({ couponOrder: order._id })
      .select("+claimToken +providerMessageId +lastError")
      .lean();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.status).toBe("sent");
      expect(job.attempts).toBe(1);
      expect(job.sentAt).toBeInstanceOf(Date);
      expect(job.claimToken).toBe("");
      expect(job.claimExpiresAt).toBeNull();
      expect(job.nextAttemptAt).toBeNull();
      expect(job.providerMessageId).toBe(`postmark-${job._id}`);
      expect(job.lastError).toBe("");
    }
    const delivered = await CouponOrder.findById(order._id);
    expect(delivered?.customerEmailSent).toBe(true);
    expect(delivered?.adminEmailSent).toBe(true);
    expect(delivered?.emailSent).toBe(true);
    expect(delivered?.customerEmailSentAt).toBeInstanceOf(Date);
    expect(delivered?.adminEmailSentAt).toBeInstanceOf(Date);
    expect(external.prepareCustomer).toHaveBeenCalledOnce();
    expect(external.prepareAdmin).toHaveBeenCalledOnce();
    expect(external.prepareCustomer.mock.calls[0][0].attachments).toHaveLength(
      2,
    );
    expect(external.email).toHaveBeenCalledTimes(2);

    // A later worker sweep cannot send an already recorded outcome again.
    await expect(
      delivery.processVoucherDeliveryOutbox({ limit: 5 }),
    ).resolves.toEqual({ processed: 0, sent: 0 });
    expect(external.email).toHaveBeenCalledTimes(2);
    expect(await Coupon.countDocuments()).toBe(2);
    expect(await VoucherLedger.countDocuments({ kind: "issue" })).toBe(2);
  });

  it("resends an archived offering's purchased vouchers through managed email without changing codes, value or artwork", async () => {
    await Product.create({
      _id: productId,
      tenant: tenantId,
      name: "Purchased voucher",
      voucherTemplate: "retained-purchased-template.pdf",
      price: 50,
      isActive: true,
      isArchived: false,
    });
    const order = await purchasedOrder();
    const input = {
      tenantId: String(tenantId),
      couponOrderId: String(order._id),
    };
    await couponService.finalizePaidCouponOrder(input);
    const originalOrder = (await CouponOrder.findById(order._id).lean())!;
    const couponProjection =
      "_id promoCode valueMinorSnapshot remainingValueMinor currencySnapshot expiresAt";
    const originalCoupons = await Coupon.find({ order: order._id })
      .select(couponProjection)
      .sort({ _id: 1 })
      .lean();
    await Product.updateOne(
      { _id: productId },
      {
        $set: {
          isActive: false,
          isArchived: true,
          price: 999,
          voucherTemplate: "replacement-artwork.pdf",
        },
      },
    );
    await VoucherDeliveryModel.updateOne(
      { couponOrder: order._id, channel: "customer", generation: 0 },
      {
        $set: {
          status: "failed",
          attempts: 8,
          nextAttemptAt: null,
          lastError: "Original SMTP connection failed.",
        },
      },
    );
    await VoucherDeliveryModel.updateOne(
      { couponOrder: order._id, channel: "admin", generation: 0 },
      { $set: { status: "sent", nextAttemptAt: null, sentAt: new Date() } },
    );
    await CouponOrder.updateOne(
      { _id: order._id },
      { $set: { adminEmailSent: true, adminEmailSentAt: new Date() } },
    );
    await configureManagedDelivery();
    external.render.mockImplementation(async ({ promoCode, templateBuffer }) =>
      Buffer.from(`%PDF-1.7 ${promoCode} ${templateBuffer.toString()}`),
    );

    await delivery.requestVoucherCustomerResend(input);
    expect(external.email).not.toHaveBeenCalled();
    await expect(
      delivery.processVoucherDeliveryOutbox({ limit: 5 }),
    ).resolves.toEqual({ processed: 1, sent: 1 });

    expect(logger.error).not.toHaveBeenCalled();
    expect(external.email).toHaveBeenCalledOnce();
    expect(external.prepareAdmin).not.toHaveBeenCalled();
    const resend = (await VoucherDeliveryModel.findOne({
      couponOrder: order._id,
      channel: "customer",
      generation: 1,
    })
      .select("+providerMessageId")
      .lean())!;
    expect(resend).toMatchObject({
      status: "sent",
      attempts: 1,
      providerMessageId: `postmark-${resend._id}`,
    });
    expect(external.email.mock.calls[0][0]).toMatchObject({
      tenantId: String(tenantId),
      orderId: String(order._id),
      to: order.email,
      deliveryId: resend._id,
      headers: { "Message-ID": `<voucher.${resend._id}@shario.io>` },
      attachments: originalOrder.promoCodesSnapshot.map((promoCode, index) => ({
        filename: `Purchased_voucher_${index + 1}.pdf`,
        contentType: "application/pdf",
        content: Buffer.from(`%PDF-1.7 ${promoCode} retained-template`),
      })),
    });
    expect(external.storage).toHaveBeenCalledExactlyOnceWith({
      key: "retained-purchased-template.pdf",
    });
    expect(external.render.mock.calls.map(([params]) => params.promoCode)).toEqual(
      originalOrder.promoCodesSnapshot,
    );
    expect(await Product.findById(productId).lean()).toMatchObject({
      isArchived: true,
      isActive: false,
      price: 999,
      voucherTemplate: "replacement-artwork.pdf",
    });
    const resentOrder = await CouponOrder.findById(order._id).lean();
    expect(resentOrder).toMatchObject({
      promoCodesSnapshot: originalOrder.promoCodesSnapshot,
      coupons: originalOrder.coupons,
      unitPriceSnapshot: 50,
      currencySnapshot: "CZK",
      voucherTemplateKeySnapshot: "retained-purchased-template.pdf",
      expiresAtSnapshot: originalOrder.expiresAtSnapshot,
      deliveryResendGeneration: 1,
      customerEmailSent: true,
      emailSent: true,
    });
    expect(
      await Coupon.find({ order: order._id })
        .select(couponProjection)
        .sort({ _id: 1 })
        .lean(),
    ).toEqual(originalCoupons);
    expect(await VoucherLedger.countDocuments({ kind: "issue" })).toBe(2);
    expect(await VoucherDeliveryModel.countDocuments()).toBe(3);
    expect(
      await VoucherDeliveryModel.findOne({
        couponOrder: order._id,
        channel: "customer",
        generation: 0,
      })
        .select("+lastError")
        .lean(),
    ).toMatchObject({
      status: "failed",
      attempts: 8,
      nextAttemptAt: null,
      lastError: "Original SMTP connection failed.",
    });
  });
});
