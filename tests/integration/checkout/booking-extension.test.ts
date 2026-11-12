import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Stripe from "stripe";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Exercise real persistence, payment signatures, fulfillment and credit ledger
// transactions. Only provider calls and outbound delivery are replaced.
vi.mock(
  "@/modules/tenant-payments/services/tenant-payment-connect.service.js",
  () => ({
    requireReadyTenantConnectedAccount: async () => ({
      stripeAccountId: "acct_booking_flow_test",
    }),
  }),
);
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({
    defaultTaxRateBps: 0,
    pricesIncludeTax: true,
  }),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({
  ensurePaidOrderInvoice: vi.fn(),
}));
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerBookingLifecycleNotificationSafely: vi.fn(),
  publishCustomerRefundNotificationSafely: vi.fn(),
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.business-events.js",
  () => ({
    emitBookingCreatedNotificationsForOrderSafely: vi.fn(),
    emitPaymentRefundedNotificationSafely: vi.fn(),
  }),
);
vi.mock("@/modules/membership/services/membership-webhook.service.js", () => ({
  handleMembershipStripeEvent: vi.fn().mockResolvedValue(false),
}));
vi.mock(
  "@/modules/pottery-piece/services/pottery-piece-checkout.service.js",
  () => ({
    processPiecePaymentEvent: vi.fn().mockResolvedValue(false),
  }),
);

vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: vi
    .fn()
    .mockResolvedValue({ queueAccepted: true, state: "waiting" }),
}));
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import {
  getBookingExtensionOptions,
  resolveExtensionPrice,
  normalizeExtensionCart,
  fulfillBookingExtensions,
  cancelPendingBookingExtension,
} from "@/modules/booking/booking.extension.service.js";
import { getCustomerBookingCapabilities } from "@/modules/booking/booking.customer.service.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import Booking from "@/modules/booking/booking.model.js";
import { cancelBookingWithRefund } from "@/modules/booking/services/booking.refund.service.js";
import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import Location from "@/modules/location/location.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import TenantPaymentAccount from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import {
  constructTenantPaymentConnectEvent,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { handleTenantPaymentConnectEvent } from "@/modules/tenant-payments/services/tenant-payment-connect.webhook.service.js";
import User from "@/modules/user/user.model.js";

const tenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const otherCustomer = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const accountId = "acct_booking_flow_test";
const signingSecret = "whsec_booking_flow_test";
const initialBalance = 50_000;
const models = [
  CommunicationEmailLogModel,
  Booking,
  AccessCodeNotification,
  Cart,
  CheckoutOperationModel,
  Location,
  MoneyCredit,
  Order,
  Product,
  Tenant,
  TenantPaymentAccount,
  User,
];
let replica: MongoMemoryReplSet;
let user: any;
let createSession: ReturnType<typeof vi.spyOn>;
let retrieveSession: ReturnType<typeof vi.spyOn>;

const bookingRequest = (key = "booking-flow-checkout-1") => ({
  tenantId: String(tenant),
  user,
  originUrl: "https://studio.example.test",
  currency: "CZK",
  locale: "en",
  membershipDiscountEligible: false,
  idempotencyKey: key,
  cartItems: [
    {
      product: {
        _id: product,
        type: "workshop",
        kind: "open-studio",
        price: 0,
      },
      locationId: location,
      start: "2030-01-07T10:00:00.000Z",
      end: "2030-01-07T11:00:00.000Z",
      quantity: 1,
      numberOfGuests: 1,
      bookingMode: "public",
      plannedActivity: "UNDEFINED",
    },
  ],
});

const paidEvent = (checkout: any, overrides: Record<string, unknown> = {}) => ({
  id: `evt_${checkout.sessionId}`,
  object: "event",
  type: "checkout.session.completed",
  account: accountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: checkout.sessionId,
      object: "checkout.session",
      client_reference_id: String(checkout.orderId),
      status: "complete",
      payment_status: "paid",
      payment_intent: `pi_${checkout.sessionId}`,
      amount_total: 25_000,
      currency: "czk",
      livemode: false,
      metadata: {
        sharioManaged: "true",
        sharioFlow: "order",
        orderId: String(checkout.orderId),
        tenantId: String(tenant),
      },
      ...overrides,
    },
  },
});

const deliver = async (
  event: ReturnType<typeof paidEvent>,
  secret = signingSecret,
) => {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  await handleTenantPaymentConnectEvent(
    constructTenantPaymentConnectEvent(Buffer.from(payload), signature),
  );
};

const booked = () => Booking.findOne({ tenant, createdBy: customer }).lean();
const balance = async () =>
  (await User.findById(customer).lean())!.moneyCreditsMinor;
const cancel = (bookingId: any, tenantId = tenant, userId = customer) =>
  cancelBookingWithRefund({
    tenantId: String(tenantId),
    userId: String(userId),
    bookingId: String(bookingId),
  });

describe("Booking extensions: quotes, capacity holds, paid fulfillment and refunds", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", "sk_test_booking_flow");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", signingSecret);
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await mongoose.disconnect();
    await replica?.stop();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({
      _id: tenant,
      slug: "booking-flow",
      plan: "studio_plus",
      planVersion: 3,
      settings: { currency: "CZK" },
    });
    await User.collection.insertMany([
      {
        _id: customer,
        tenant,
        firstname: "Flow",
        lastname: "Customer",
        email: "flow@example.test",
        customId: "FLOW-1",
        memberNumber: 42,
        tenantRole: "customer",
        platformRole: "none",
        isAccessGranted: true,
        moneyCredits: initialBalance / 100,
        moneyCreditsMinor: initialBalance,
      },
      {
        _id: otherCustomer,
        tenant: otherTenant,
        firstname: "Other",
        email: "other@example.test",
        customId: "FLOW-OTHER",
        memberNumber: 1,
        moneyCredits: 0,
        moneyCreditsMinor: 0,
      },
    ]);
    user = await User.findById(customer).lean();
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Test studio",
      isActive: true,
      booking: {
        enabled: true,
        timezone: "UTC",
        globalCapacity: 1,
        capacityRevision: 0,
        activitySelectionMode: "HIDDEN",
        privateSessionBlocksAll: true,
        slotStepMinutes: 30,
        minBookingMinutes: 60,
        maxBookingMinutes: 360,
      },
      openingHours: {
        monday: { isOpen: true, openTime: "08:00", closeTime: "18:00" },
      },
    });
    await Product.collection.insertOne({
      _id: product,
      tenant,
      location,
      createdBy: customer,
      name: "Test Open Studio",
      type: "workshop",
      kind: "open-studio",
      kindContractVersion: 2,
      bookingMode: "public",
      price: 125,
      extraCharge: 0,
      currency: "CZK",
      maxNumberOfParticipants: 1,
      isActive: true,
      isArchived: false,
    });
    await TenantPaymentAccount.collection.insertOne({
      tenant,
      stripeAccountId: accountId,
    });
    retrieveSession = vi.spyOn(
      getTenantPaymentStripe().checkout.sessions,
      "retrieve",
    );
    createSession = vi
      .spyOn(getTenantPaymentStripe().checkout.sessions, "create")
      .mockImplementation(async (input: any) => {
        const session = {
          id: `cs_booking_${input.client_reference_id}`,
          url: "https://checkout.stripe.test/booking",
          status: "open",
          payment_status: "unpaid",
          livemode: false,
          expires_at: input.expires_at,
          metadata: input.metadata,
          currency: input.line_items[0].price_data.currency,
          amount_total: Number(input.metadata.expectedAmountMinor),
          client_reference_id: input.client_reference_id,
        };
        retrieveSession.mockResolvedValue(session as never);
        return session as never;
      });
  });

  const original = async () => {
    await checkoutService.checkoutWithCredits(bookingRequest("original"));
    user = await User.findById(customer).lean();
    return (await Booking.findOne({ tenant, tag: "open-studio" }).lean())!;
  };
  const options = (bookingId: any) =>
    getBookingExtensionOptions({
      tenantId: String(tenant),
      userId: String(customer),
      bookingId: String(bookingId),
    });
  const extensionRequest = async (
    booking: any,
    minutes = 30,
    key = "extend-1",
  ) => {
    const quote = await options(booking._id);
    const option = quote.options.find(
      (option: any) => option.minutes === minutes,
    )!;
    return {
      ...bookingRequest(key),
      cartItems: [
        {
          bookingExtension: {
            bookingId: String(booking._id),
            minutes,
            expectedEnd: quote.currentEnd,
            expectedAmountMinor: option.amountMinor,
            quoteVersion: quote.quoteVersion,
          },
          language: "en",
        },
      ],
    };
  };

  it("offers only intervals that fit, including exact adjacency with the next private booking", async () => {
    const booking = await original();
    await Booking.create({
      ...booking,
      _id: new mongoose.Types.ObjectId(),
      start: new Date("2030-01-07T12:00Z"),
      end: new Date("2030-01-07T13:00Z"),
      bookingMode: "private",
      bookingType: "private",
      createdBy: otherCustomer,
    });
    const quote = await options(booking._id);
    expect(
      quote.options.map((option: any) => [option.minutes, option.available]),
    ).toEqual([
      [30, true],
      [60, true],
      [90, false],
      [120, false],
    ]);
    expect(quote.options[0]).toMatchObject({
      amountMinor: 12500,
      pricingSource: "original_booking",
    });
    await expect(
      getBookingExtensionOptions({
        tenantId: String(otherTenant),
        userId: String(customer),
        bookingId: String(booking._id),
      }),
    ).rejects.toThrow("not found");
    await expect(
      getBookingExtensionOptions({
        tenantId: String(tenant),
        userId: String(otherCustomer),
        bookingId: String(booking._id),
      }),
    ).rejects.toThrow("not found");
  });

  it("extends the one existing booking with credits once and writes one durable email", async () => {
    const booking = await original();
    const request = await extensionRequest(booking);
    const result = await checkoutService.checkoutWithCredits(request);
    expect(result).toMatchObject({ success: true, amountCharged: 125 });
    expect(await Booking.findById(booking._id).lean()).toMatchObject({
      start: booking.start,
      end: new Date("2030-01-07T11:30Z"),
      bookingMode: "public",
      numberOfGuests: 1,
      extensionBaseDurationMinutes: 60,
    });
    expect(await Booking.countDocuments({ tenant, tag: "open-studio" })).toBe(
      1,
    );
    expect(await balance()).toBe(12500);
    await checkoutService.checkoutWithCredits(request);
    expect(await balance()).toBe(12500);
    expect(
      await CommunicationEmailLogModel.countDocuments({
        tenant,
        emailType: "bookingExtended",
      }),
    ).toBe(1);
    const order = await Order.findById(result.orderId).lean();
    expect(order?.locationIds.map(String)).toEqual([String(booking.location)]);
    expect(order?.lineItems[0].locationIds.map(String)).toEqual([String(booking.location)]);
    expect(order).toMatchObject({
      workshopBookings: [booking._id],
      bookingExtension: { bookingId: booking._id, amountMinor: 12500 },
    });
    await expect(cancel(booking._id)).resolves.toMatchObject({
      refundAmount: 375,
    });
    expect(await balance()).toBe(initialBalance);
  });

  it("preserves the purchased rate after a catalog price change and never repeats the private fee", async () => {
    await Product.updateOne(
      { _id: product },
      {
        $set: {
          bookingMode: "customer-choice",
          openStudioPolicy: {
            privateBookingSurcharge: 100,
            publicCapacityMode: "location",
          },
        },
      },
    );
    const request: any = bookingRequest("private-original");
    request.cartItems[0].bookingMode = "private";
    await checkoutService.checkoutWithCredits(request);
    const booking = (await Booking.findOne({
      tenant,
      tag: "open-studio",
    }).lean())!;
    await Product.updateOne({ _id: product }, { $set: { price: 999 } });
    const quote = await options(booking._id);
    expect(quote.options[0]).toMatchObject({
      amountMinor: 12500,
      pricingSource: "original_booking",
    });
    expect(quote.options[1].amountMinor).toBe(25000);
  });

  it("allows an active booking after door code delivery, using credits near its end", async () => {
    const booking = await original();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-07T10:45Z"));
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "accessCodeDelivery.status": "sent" } },
    );
    expect(
      getCustomerBookingCapabilities({ ...booking, accessCodeDelivered: true }),
    ).toMatchObject({
      canExtend: true,
      canCancel: false,
      canReschedule: false,
    });
    const quote = await options(booking._id);
    expect(quote.paymentMethods).toEqual(["credits"]);
    const request = await extensionRequest(booking);
    await expect(
      checkoutService.createStripeCheckout(request),
    ).rejects.toMatchObject({ code: "CUSTOMER_BOOKING_EXTENSION_CARD_WINDOW" });
    await checkoutService.checkoutWithCredits({
      ...request,
      idempotencyKey: "credit-active",
    });
    expect(
      (await Booking.findById(booking._id).lean())!.accessCodeDelivery.status,
    ).toBe("sent");
  });

  it("holds extension capacity for card payment, keeps original unchanged, and fulfills a repeated callback once", async () => {
    const booking = await original();
    const request = await extensionRequest(booking);
    const checkout = await checkoutService.createStripeCheckout(request);
    const extensionOrder = await Order.findById(checkout.orderId).lean();
    expect(extensionOrder?.locationIds.map(String)).toEqual([String(booking.location)]);
    expect(extensionOrder?.lineItems[0].locationIds.map(String)).toEqual([String(booking.location)]);
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    const pending = await options(booking._id);
    expect(pending.pendingExtension).toMatchObject({
      orderId: String(checkout.orderId),
      url: "https://checkout.stripe.test/booking",
    });
    const other: any = bookingRequest("competing");
    other.cartItems[0].start = "2030-01-07T11:00Z";
    other.cartItems[0].end = "2030-01-07T12:00Z";
    await expect(
      checkoutService.checkoutWithCredits(other),
    ).rejects.toMatchObject({ statusCode: 409 });
    const event = paidEvent(checkout, { amount_total: 12500 });
    await deliver(event);
    await deliver(event);
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      new Date("2030-01-07T11:30Z"),
    );
    expect(await Booking.countDocuments({ tenant, tag: "open-studio" })).toBe(
      1,
    );
    expect(
      await CommunicationEmailLogModel.countDocuments({
        tenant,
        emailType: "bookingExtended",
      }),
    ).toBe(1);
  });

  it("rejects stale and tampered prices without a debit, and serializes concurrent extensions", async () => {
    const booking = await original();
    const request: any = await extensionRequest(booking);
    const tampered = structuredClone(request);
    tampered.user = user;
    tampered.cartItems[0].bookingExtension.expectedAmountMinor = 1;
    await expect(
      checkoutService.checkoutWithCredits(tampered),
    ).rejects.toMatchObject({
      code: "CUSTOMER_BOOKING_EXTENSION_PRICE_CHANGED",
    });
    expect(await balance()).toBe(25000);
    const results = await Promise.allSettled([
      checkoutService.checkoutWithCredits({
        ...request,
        idempotencyKey: "concurrent-a",
      }),
      checkoutService.checkoutWithCredits({
        ...request,
        idempotencyKey: "concurrent-b",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await balance()).toBe(12500);
    await expect(
      checkoutService.checkoutWithCredits({
        ...request,
        idempotencyKey: "stale-extension",
      }),
    ).rejects.toMatchObject({ code: "CUSTOMER_BOOKING_EXTENSION_STALE" });
  });

  it("releases an expired card hold without changing the original or charging credits", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    await checkoutRepository.releaseExpiredStripeOrder({
      tenantId: tenant,
      orderId: checkout.orderId,
      sessionId: checkout.sessionId,
      connectedAccountId: accountId,
    });
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect((await options(booking._id)).canExtend).toBe(true);
    expect(await balance()).toBe(25000);
  });
  it("refunds a late card completion instead of extending an ended booking", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    const refund = vi
      .spyOn(getTenantPaymentStripe().refunds, "create")
      .mockResolvedValue({
        id: "re_extension_late",
        status: "succeeded",
        amount: 12500,
        currency: "czk",
        payment_intent: `pi_${checkout.sessionId}`,
      } as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-07T11:01Z"));
    const event = paidEvent(checkout, { amount_total: 12500 });
    await deliver(event);
    await deliver(event);
    expect(refund).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({
      status: "cancelled_order",
      bookingExtension: {
        refundId: "re_extension_late",
        refundStatus: "succeeded",
      },
    });
    expect(
      await CommunicationEmailLogModel.countDocuments({
        emailType: "bookingExtended",
      }),
    ).toBe(0);
    refund.mockRestore();
  });

  it("never fulfills after refund intent even if the original availability recovers", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    // An administrator changes the original before callback; payment must be refunded.
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { end: new Date("2030-01-07T10:30Z") } },
    );
    const createRefund = vi
      .spyOn(getTenantPaymentStripe().refunds, "create")
      .mockResolvedValue({
        id: "re_extension_pending",
        status: "pending",
        amount: 12500,
        currency: "czk",
        payment_intent: `pi_${checkout.sessionId}`,
      } as never);
    const retrieveRefund = vi
      .spyOn(getTenantPaymentStripe().refunds, "retrieve")
      .mockResolvedValue({
        id: "re_extension_pending",
        status: "succeeded",
        amount: 12500,
        currency: "czk",
        payment_intent: `pi_${checkout.sessionId}`,
      } as never);
    const event = paidEvent(checkout, { amount_total: 12500 });
    await expect(deliver(event)).rejects.toThrow("refund");
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { end: booking.end } },
    );
    await deliver(event);
    expect(createRefund).toHaveBeenCalledOnce();
    expect(retrieveRefund).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect((await Order.findById(checkout.orderId).lean())!.status).toBe(
      "cancelled_order",
    );
    createRefund.mockRestore();
    retrieveRefund.mockRestore();
  });

  it("refuses a changed guest/privacy/activity snapshot after card checkout", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { numberOfGuests: 2 } },
    );
    const createRefund = vi
      .spyOn(getTenantPaymentStripe().refunds, "create")
      .mockResolvedValue({
        id: "re_changed_party",
        status: "succeeded",
        amount: 12500,
        currency: "czk",
        payment_intent: `pi_${checkout.sessionId}`,
      } as never);
    await deliver(paidEvent(checkout, { amount_total: 12500 }));
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect(createRefund).toHaveBeenCalledOnce();
    createRefund.mockRestore();
  });

  it("rolls back fulfillment if the paid-order commit fails and safely retries", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    const commit = vi
      .spyOn(checkoutRepository, "markOrderProcessed")
      .mockRejectedValueOnce(new Error("temporary commit failure"));
    const event = paidEvent(checkout, { amount_total: 12500 });
    await expect(deliver(event)).rejects.toThrow("temporary commit failure");
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect(
      await CommunicationEmailLogModel.countDocuments({
        emailType: "bookingExtended",
      }),
    ).toBe(0);
    await deliver(event);
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      new Date("2030-01-07T11:30Z"),
    );
    expect((await Order.findById(checkout.orderId).lean())!.status).toBe(
      "processed_order",
    );
    commit.mockRestore();
  });

  it("finishes pending refunds from signed provider updates without extending the booking", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { numberOfGuests: 2 } },
    );
    const refund = {
      id: "re_extension_event",
      object: "refund",
      status: "pending",
      amount: 12500,
      currency: "czk",
      payment_intent: `pi_${checkout.sessionId}`,
      metadata: {
        sharioManaged: "true",
        tenantId: String(tenant),
        orderId: String(checkout.orderId),
        reason: "booking_extension_unfulfilled",
      },
    };
    const createRefund = vi
      .spyOn(getTenantPaymentStripe().refunds, "create")
      .mockResolvedValue(refund as never);
    await expect(
      deliver(paidEvent(checkout, { amount_total: 12500 })),
    ).rejects.toThrow("refund");
    const event: any = {
      id: "evt_refund_done",
      type: "refund.updated",
      account: accountId,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...refund, status: "succeeded" } },
    };
    await deliver(event);
    await deliver(event);
    expect((await Order.findById(checkout.orderId).lean())!.status).toBe(
      "cancelled_order",
    );
    expect(
      (await Booking.findById(booking._id).lean())!.extensionPaymentOrder,
    ).toBeNull();
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    createRefund.mockRestore();
  });

  it("reanchors unsent end-based emails and keeps the original purchased rate after a move", async () => {
    const booking = await original();
    await CommunicationEmailLogModel.create({
      tenant,
      user: customer,
      recipientEmail: "flow@example.test",
      subject: "After visit",
      automation: new mongoose.Types.ObjectId(),
      emailType: "afterBooking",
      status: "queued",
      relatedEntityType: "booking",
      relatedEntityId: booking._id,
      sourceScheduledAt: booking.end,
    });
    await checkoutService.checkoutWithCredits(await extensionRequest(booking));
    expect(
      await CommunicationEmailLogModel.findOne({
        emailType: "afterBooking",
      }).lean(),
    ).toMatchObject({ status: "canceled" });
    await Booking.updateOne(
      { _id: booking._id },
      {
        $set: {
          start: new Date("2030-01-14T10:00Z"),
          end: new Date("2030-01-14T11:30Z"),
        },
      },
    );
    const quote = await options(booking._id);
    expect(quote.options[0]).toMatchObject({
      amountMinor: 12500,
      pricingSource: "original_booking",
    });
  });

  it("cancels only the pending card extension and allows a fresh attempt", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    const expire = vi
      .spyOn(getTenantPaymentStripe().checkout.sessions, "expire")
      .mockResolvedValue({
        id: checkout.sessionId,
        status: "expired",
        payment_status: "unpaid",
      } as never);
    await cancelPendingBookingExtension({
      tenantId: String(tenant),
      userId: String(customer),
      bookingId: String(booking._id),
      orderId: String(checkout.orderId),
    });
    expect(expire).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id).lean())!.status).toBe(
      "processed",
    );
    expect((await options(booking._id)).canExtend).toBe(true);
    await checkoutService.checkoutWithCredits(
      await extensionRequest(booking, 30, "retry-after-cancel"),
    );
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      new Date("2030-01-07T11:30Z"),
    );
    expire.mockRestore();
  });

  it("prices current guests from the original discounted per-person rate and explains missing or membership snapshots", async () => {
    const booking: any = await original();
    const order: any = await Order.findById(booking.orders[0])
      .populate("cart")
      .lean();
    const catalog: any = await Product.findById(product).lean();
    const discounted = {
      ...order,
      lineItems: order.lineItems.map((line: any) => ({
        ...line,
        grossAmountMinor: 20000,
      })),
    };
    expect(
      resolveExtensionPrice(
        { ...booking, numberOfGuests: 2 },
        catalog,
        [discounted],
        30,
      ),
    ).toMatchObject({ amountMinor: 20000, pricingSource: "original_booking" });
    expect(resolveExtensionPrice(booking, catalog, [], 30)).toMatchObject({
      amountMinor: 12500,
      pricingSource: "current_price",
    });
    expect(
      resolveExtensionPrice(
        booking,
        catalog,
        [{ ...order, paymentAllocations: [{ method: "membership_credit" }] }],
        30,
      ),
    ).toMatchObject({ amountMinor: 12500, pricingSource: "current_price" });
  });

  it("refunds a payment arriving after its checkout was cancelled instead of reopening its hold", async () => {
    const booking = await original();
    const checkout = await checkoutService.createStripeCheckout(
      await extensionRequest(booking),
    );
    await checkoutRepository.releaseExpiredStripeOrder({
      tenantId: tenant,
      orderId: checkout.orderId,
      sessionId: checkout.sessionId,
      connectedAccountId: accountId,
    });
    const refund = vi
      .spyOn(getTenantPaymentStripe().refunds, "create")
      .mockResolvedValue({
        id: "re_expired_payment",
        status: "succeeded",
        amount: 12500,
        currency: "czk",
        payment_intent: `pi_${checkout.sessionId}`,
      } as never);
    const event = paidEvent(checkout, { amount_total: 12500 });
    await deliver(event);
    await deliver(event);
    expect(refund).toHaveBeenCalledOnce();
    expect((await Booking.findById(booking._id).lean())!.end).toEqual(
      booking.end,
    );
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({
      status: "cancelled_order",
      bookingExtension: { refundStatus: "succeeded" },
    });
    refund.mockRestore();
  });

  it("keeps closing time and maximum duration authoritative", async () => {
    const booking = await original();
    await Location.updateOne(
      { _id: location },
      { $set: { "openingHours.monday.closeTime": "11:30" } },
    );
    let quote = await options(booking._id);
    expect(quote.options.map((option: any) => option.available)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    await Location.updateOne(
      { _id: location },
      {
        $set: {
          "openingHours.monday.closeTime": "18:00",
          "booking.maxBookingMinutes": 90,
        },
      },
    );
    quote = await options(booking._id);
    expect(quote.options.map((option: any) => option.available)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});
