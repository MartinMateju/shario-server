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

const external = vi.hoisted(() => ({
  stripe: vi.fn(),
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
  readyAccount: vi.fn(),
  discount: vi.fn(),
  invoice: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: external.stripe,
  getConnectedAccountRequestOptions: (account: string, options = {}) => ({
    stripeAccount: account,
    ...options,
  }),
}));
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({
    requireReadyTenantConnectedAccount: external.readyAccount,
  }),
);
vi.mock("@/modules/membership/services/membership-discount.service.js", () => ({
  resolveMembershipProductDiscount: external.discount,
}));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({
    defaultTaxRateBps: 0,
    pricesIncludeTax: true,
  }),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({
  ensurePaidOrderInvoice: external.invoice,
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.business-events.js",
  () => ({
    emitBookingCreatedNotificationsForOrderSafely: external.notify,
  }),
);

import Booking from "@/modules/booking/booking.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import * as checkoutOperations from "@/modules/checkout/checkout-idempotency.service.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import Location from "@/modules/location/location.model.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";
import Order from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";

const tenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const booking = new mongoose.Types.ObjectId();
const balanceMinor = 435_050;
const models = [
  Tenant,
  User,
  Location,
  Product,
  Booking,
  Cart,
  Order,
  CheckoutOperationModel,
];
let replica: MongoMemoryReplSet;
let user: any;
let debit: ReturnType<typeof vi.spyOn>;

const request = (overrides: Record<string, unknown> = {}) => ({
  tenantId: String(tenant),
  user,
  cartItems: [
    {
      product: { _id: product, type: "course", price: 0, currency: "CZK" },
      bookingCourse: booking,
      quantity: 1,
    },
  ],
  originUrl: "https://studio.example.test",
  currency: "CZK",
  locale: "en",
  membershipDiscountEligible: true,
  idempotencyKey: "free-cart-request-0001",
  ...overrides,
});

describe("authenticated cart zero-price fulfillment", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ launchTimeout: 30_000 }],
    });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    external.discount.mockResolvedValue(null);
    external.invoice.mockResolvedValue(null);
    external.notify.mockResolvedValue(undefined);
    external.readyAccount.mockResolvedValue({
      stripeAccountId: "acct_cart_test",
    });
    external.stripe.mockReturnValue({
      checkout: {
        sessions: {
          create: external.createSession,
          retrieve: external.retrieveSession,
        },
      },
    });
    external.createSession.mockImplementation(async (input) => {
      const response = {
        id: "cs_cart_test",
        url: "https://checkout.stripe.test/cs_cart_test",
        status: "open",
        livemode: false,
        expires_at: input.expires_at,
        metadata: input.metadata,
        currency: input.line_items[0].price_data.currency,
        amount_total: Number(input.metadata.expectedAmountMinor),
        client_reference_id: input.client_reference_id,
      };
      external.retrieveSession.mockResolvedValue(response);
      return response;
    });
    debit = vi.spyOn(moneyCreditService, "incrementMoneyCredits");
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({
      _id: tenant,
      slug: "free-cart",
      name: "Test studio",
      settings: { currency: "CZK" },
    });
    await User.collection.insertOne({
      _id: customer,
      tenant,
      firstname: "Test",
      lastname: "Customer",
      email: "customer@example.test",
      customId: "FREE-1",
      tenantRole: "owner",
      platformRole: "none",
      isAccessGranted: true,
      moneyCreditsMinor: balanceMinor,
      moneyCredits: balanceMinor / 100,
    });
    user = await User.findById(customer).lean();
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Test location",
      isActive: true,
    });
    await Product.collection.insertOne({
      _id: product,
      tenant,
      location,
      createdBy: customer,
      name: { EN: "Free class", CZ: "Free class" },
      type: "course",
      kind: "class",
      kindContractVersion: 2,
      isActive: true,
      isArchived: false,
      price: 0,
      extraCharge: 0,
      currency: "CZK",
      maxNumberOfParticipants: 1,
    });
    await Booking.collection.insertOne({
      _id: booking,
      tenant,
      location,
      bookingProduct: product,
      createdBy: customer,
      start: new Date(Date.now() + 172_800_000),
      end: new Date(Date.now() + 176_400_000),
      tag: "class",
      archive: false,
      status: "processed",
      paymentStatus: "CONFIRMED",
      numberOfGuests: 0,
      orders: [],
      participants: [],
      capacityReservations: [],
      waitlistHolds: [],
      waitlistConfig: { enabled: false, autoPromote: false },
    });
  });

  it("fulfills a free canonical class with the original card operation and no Stripe or credit debit", async () => {
    // A free booking need not leave time for Stripe's payment window.
    await Booking.updateOne(
      { _id: booking },
      { $set: { start: new Date(Date.now() + 600_000) } },
    );
    const input = request();
    input.cartItems[0].product.price = 999;
    const result = await checkoutService.createStripeCheckout(input);
    expect(result).toMatchObject({
      success: true,
      status: "confirmed",
      amountCharged: 0,
    });
    expect(result.url).toBe(
      `https://studio.example.test/en/portal/success?orderId=${result.orderId}`,
    );
    const order = await Order.findById(result.orderId).lean();
    expect(order).toMatchObject({
      status: "processed_order",
      isPaid: true,
      paidAt: expect.any(Date),
      grossAmountMinor: 0,
      expectedAmountMinor: 0,
      paidAmountMinor: 0,
      paymentAllocations: [
        expect.objectContaining({ method: "free", amountMinor: 0 }),
      ],
      lineItems: [
        expect.objectContaining({ product, booking, grossAmountMinor: 0 }),
      ],
    });
    expect(await Booking.findById(booking).lean()).toMatchObject({
      numberOfGuests: 1,
      orders: [order!._id],
      participants: [expect.objectContaining({ order: order!._id })],
      capacityReservations: [],
    });
    expect(
      await CheckoutOperationModel.findOne({ tenant }).lean(),
    ).toMatchObject({
      kind: "card",
      state: "completed",
      orderId: order!._id,
      response: expect.objectContaining({ status: "confirmed" }),
    });
    expect(await User.findById(customer).lean()).toMatchObject({
      moneyCreditsMinor: balanceMinor,
    });
    expect(debit).not.toHaveBeenCalled();
    expect(external.stripe).not.toHaveBeenCalled();
    expect(external.readyAccount).not.toHaveBeenCalled();
    expect(external.invoice).toHaveBeenCalledOnce();
    expect(external.notify).toHaveBeenCalledOnce();
  });

  it("replays the committed free order even after the catalog changes, without duplicate seats or side effects", async () => {
    const result = await checkoutService.createStripeCheckout(request());
    await Product.updateOne({ _id: product }, { $set: { price: 125 } });
    const replay = await checkoutService.createStripeCheckout(request());
    expect(String(replay.orderId)).toBe(String(result.orderId));
    expect(replay).toMatchObject({ status: "confirmed", url: result.url });
    expect(await Order.countDocuments({ tenant })).toBe(1);
    expect(await Cart.countDocuments({ tenant })).toBe(1);
    expect(await CheckoutOperationModel.countDocuments({ tenant })).toBe(1);
    expect(await Booking.findById(booking).lean()).toMatchObject({
      numberOfGuests: 1,
    });
    expect(external.notify).toHaveBeenCalledOnce();
    expect(external.invoice).toHaveBeenCalledOnce();
    expect(external.stripe).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });

  it("uses the server's positive price despite a client zero price, and preserves Stripe retries", async () => {
    await Product.updateOne({ _id: product }, { $set: { price: 125 } });
    const result = await checkoutService.createStripeCheckout(request());
    expect(result.url).toBe("https://checkout.stripe.test/cs_cart_test");
    expect(result.status).not.toBe("confirmed");
    expect(await Order.findById(result.orderId).lean()).toMatchObject({
      status: "pending_order",
      isPaid: false,
      grossAmountMinor: 12_500,
      expectedAmountMinor: 12_500,
      stripe: { sessionId: "cs_cart_test" },
    });
    expect(external.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 12_500 }),
          }),
        ],
      }),
      expect.objectContaining({ stripeAccount: "acct_cart_test" }),
    );
    const replay = await checkoutService.createStripeCheckout(request());
    expect(String(replay.orderId)).toBe(String(result.orderId));
    expect(external.createSession).toHaveBeenCalledOnce();
    expect(await Booking.findById(booking).lean()).toMatchObject({
      numberOfGuests: 0,
      participants: [],
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it("rejects a price increase during free routing before any credit debit or fulfillment", async () => {
    const loadProducts =
      checkoutRepository.loadProductsByIds.bind(checkoutRepository);
    vi.spyOn(checkoutRepository, "loadProductsByIds").mockImplementationOnce(
      async (input) => {
        const quoted = await loadProducts(input);
        await Product.updateOne({ _id: product }, { $set: { price: 125 } });
        return quoted;
      },
    );
    await expect(
      checkoutService.createStripeCheckout(request()),
    ).rejects.toMatchObject({ code: "CHECKOUT_PRICE_CHANGED" });
    expect(await Order.countDocuments({ tenant })).toBe(0);
    expect(await Cart.countDocuments({ tenant })).toBe(0);
    expect(await Booking.findById(booking).lean()).toMatchObject({
      numberOfGuests: 0,
      participants: [],
      capacityReservations: [],
    });
    expect(await User.findById(customer).lean()).toMatchObject({
      moneyCreditsMinor: balanceMinor,
    });
    expect(debit).not.toHaveBeenCalled();
    expect(external.stripe).not.toHaveBeenCalled();
  });

  it("fulfills a server-authorized full membership discount without charging", async () => {
    await Product.updateOne({ _id: product }, { $set: { price: 125 } });
    external.discount.mockResolvedValue({
      membershipId: new mongoose.Types.ObjectId(),
      planId: new mongoose.Types.ObjectId(),
      planVersionId: new mongoose.Types.ObjectId(),
      planVersion: 1,
      benefitKey: "free-classes",
      benefitLabel: "Free classes",
      percentageBps: 10_000,
      selectedLocationId: null,
    });
    const result = await checkoutService.createStripeCheckout(request());
    expect(result.status).toBe("confirmed");
    expect(await Order.findById(result.orderId).lean()).toMatchObject({
      grossAmountMinor: 0,
      appliedDiscount: { source: "membership", amountMinor: 12_500 },
      paymentAllocations: [
        expect.objectContaining({ method: "free", amountMinor: 0 }),
      ],
    });
    expect(debit).not.toHaveBeenCalled();
    expect(external.stripe).not.toHaveBeenCalled();
  });

  it("rolls fulfillment back with its replay record and retries with the same reserved ids", async () => {
    vi.spyOn(
      checkoutOperations,
      "completeCheckoutOperation",
    ).mockRejectedValueOnce(new Error("commit failed"));
    await expect(
      checkoutService.createStripeCheckout(request()),
    ).rejects.toThrow("commit failed");
    const operation = await CheckoutOperationModel.findOne({ tenant }).lean();
    expect(operation).toMatchObject({ kind: "card", state: "processing" });
    expect(await Order.countDocuments({ tenant })).toBe(0);
    expect(await Cart.countDocuments({ tenant })).toBe(0);
    expect(await Booking.findById(booking).lean()).toMatchObject({
      numberOfGuests: 0,
      participants: [],
      capacityReservations: [],
    });
    const retry = await checkoutService.createStripeCheckout(request());
    expect(String(retry.orderId)).toBe(String(operation!.orderId));
    expect(await Order.findById(retry.orderId).lean()).toMatchObject({
      cart: operation!.cartId,
    });
    expect(await Order.countDocuments({ tenant })).toBe(1);
    expect(external.notify).toHaveBeenCalledOnce();
    expect(debit).not.toHaveBeenCalled();
    expect(external.stripe).not.toHaveBeenCalled();
  });

  it("recovers an already-attached card session instead of repricing it as free", async () => {
    await Product.updateOne({ _id: product }, { $set: { price: 125 } });
    const original = await checkoutService.createStripeCheckout(request());
    await Product.updateOne({ _id: product }, { $set: { price: 0 } });
    await CheckoutOperationModel.updateOne(
      { tenant },
      {
        $set: { state: "processing", leaseExpiresAt: new Date(0) },
        $unset: { response: "" },
      },
    );
    const loadProducts = vi.spyOn(checkoutRepository, "loadProductsByIds");
    const recovered = await checkoutService.createStripeCheckout(request());
    expect(String(recovered.orderId)).toBe(String(original.orderId));
    expect(recovered.url).toBe(original.url);
    expect(external.createSession).toHaveBeenCalledOnce();
    expect(external.retrieveSession).toHaveBeenCalledOnce();
    expect(loadProducts).not.toHaveBeenCalled();
    expect(await Order.findById(original.orderId).lean()).toMatchObject({
      isPaid: false,
      grossAmountMinor: 12_500,
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it("keeps class capacity validation for free orders", async () => {
    await Booking.updateOne({ _id: booking }, { $set: { numberOfGuests: 1 } });
    await expect(
      checkoutService.createStripeCheckout(request()),
    ).rejects.toMatchObject({ code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED" });
    expect(await Order.countDocuments({ tenant })).toBe(0);
    expect(external.stripe).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });

  it("rejects an empty cart instead of creating a free order", async () => {
    await expect(
      checkoutService.createStripeCheckout(request({ cartItems: [] })),
    ).rejects.toThrow();
    expect(await Order.countDocuments({ tenant })).toBe(0);
    expect(external.stripe).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });
});
