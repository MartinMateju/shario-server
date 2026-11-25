import { PaymentRefundReconciliation, PaymentRefundObservation } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise real persistence, payment signatures, fulfillment and credit ledger
// transactions. Only provider calls and outbound delivery are replaced.
vi.mock("@/modules/tenant-payments/services/tenant-payment-connect.service.js", () => ({
  requireReadyTenantConnectedAccount: async () => ({ stripeAccountId: "acct_booking_flow_test" }),
}));
vi.mock("@/modules/invoice/invoice-settings.service.js", () => ({
  ensureInvoiceSettings: async () => ({ defaultTaxRateBps: 0, pricesIncludeTax: true }),
}));
vi.mock("@/modules/invoice/invoice.service.js", () => ({ ensurePaidOrderInvoice: vi.fn() }));
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerBookingLifecycleNotificationSafely: vi.fn(),
  publishCustomerRefundNotificationSafely: vi.fn(),
}));
vi.mock("@/modules/workspace-notifications/workspace-notification.business-events.js", () => ({
  emitBookingCreatedNotificationsForOrderSafely: vi.fn(),
  emitPaymentRefundedNotificationSafely: vi.fn(),
}));
vi.mock("@/modules/membership/services/membership-webhook.service.js", () => ({
  handleMembershipStripeEvent: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/modules/pottery-piece/services/pottery-piece-checkout.service.js", () => ({
  processPiecePaymentEvent: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: vi.fn().mockResolvedValue({ queueAccepted: true, state: "waiting" }),
}));
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import Booking from "@/modules/booking/booking.model.js";
import { cancelBookingWithRefund } from "@/modules/booking/services/booking.refund.service.js";
import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import { cancelOpenStudioCardCheckout } from "@/modules/checkout/services/checkout.cancellation.service.js";
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
const models = [PaymentRefundReconciliation, PaymentRefundObservation, CommunicationEmailLogModel, Booking, AccessCodeNotification, Cart, CheckoutOperationModel, Location,
  MoneyCredit, Order, Product, Tenant, TenantPaymentAccount, User];
let replica: MongoMemoryReplSet;
let user: any;
let createSession: ReturnType<typeof vi.spyOn>;
let retrieveSession: ReturnType<typeof vi.spyOn>;
let expireSession: ReturnType<typeof vi.spyOn>;
let cardSession: any;

const bookingRequest = (key = "booking-flow-checkout-1") => ({
  tenantId: String(tenant), user, originUrl: "https://studio.example.test",
  currency: "CZK", locale: "en", membershipDiscountEligible: false, idempotencyKey: key,
  cartItems: [{
    product: { _id: product, type: "workshop", kind: "open-studio", price: 0 },
    locationId: location,
    start: "2030-01-07T10:00:00.000Z", end: "2030-01-07T11:00:00.000Z",
    quantity: 1, numberOfGuests: 1, bookingMode: "public", plannedActivity: "UNDEFINED",
  }],
});

const paidEvent = (checkout: any, overrides: Record<string, unknown> = {}) => ({
  id: `evt_${checkout.sessionId}`, object: "event", type: "checkout.session.completed",
  account: accountId, livemode: false, created: Math.floor(Date.now() / 1000),
  data: { object: {
    id: checkout.sessionId, object: "checkout.session", client_reference_id: String(checkout.orderId),
    status: "complete", payment_status: "paid", payment_intent: `pi_${checkout.sessionId}`,
    amount_total: 25_000, currency: "czk", livemode: false,
    metadata: { sharioManaged: "true", sharioFlow: "order", orderId: String(checkout.orderId), tenantId: String(tenant) },
    ...overrides,
  } },
});

const deliver = async (event: ReturnType<typeof paidEvent>, secret = signingSecret) => {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  await handleTenantPaymentConnectEvent(
    constructTenantPaymentConnectEvent(Buffer.from(payload), signature),
  );
};

const booked = () => Booking.findOne({ tenant, createdBy: customer }).lean();
const balance = async () => (await User.findById(customer).lean())!.moneyCreditsMinor;
const cancel = (bookingId: any, tenantId = tenant, userId = customer) =>
  cancelBookingWithRefund({ tenantId: String(tenantId), userId: String(userId), bookingId: String(bookingId) });
const cancelCheckout = (orderId: any, tenantId = tenant, userId = customer) =>
  cancelOpenStudioCardCheckout({ tenantId: String(tenantId), userId: String(userId), orderId: String(orderId) });

describe("Open Studio checkout, payment, cancellation and restored credit", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", "sk_test_booking_flow");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", signingSecret);
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({ _id: tenant, slug: "booking-flow", plan: "studio_plus", planVersion: 3, settings: { currency: "CZK" } });
    await User.collection.insertMany([
      { _id: customer, tenant, firstname: "Flow", lastname: "Customer", email: "flow@example.test",
        customId: "FLOW-1", memberNumber: 42, tenantRole: "customer", platformRole: "none",
        isAccessGranted: true, moneyCredits: initialBalance / 100, moneyCreditsMinor: initialBalance },
      { _id: otherCustomer, tenant: otherTenant, firstname: "Other", email: "other@example.test",
        customId: "FLOW-OTHER", memberNumber: 1, moneyCredits: 0, moneyCreditsMinor: 0 },
    ]);
    user = await User.findById(customer).lean();
    await Location.collection.insertOne({
      _id: location, tenant, name: "Test studio", isActive: true,
      booking: { enabled: true, timezone: "UTC", globalCapacity: 1, capacityRevision: 0,
        activitySelectionMode: "HIDDEN", privateSessionBlocksAll: true, slotStepMinutes: 30,
        minBookingMinutes: 60, maxBookingMinutes: 360 },
      openingHours: { monday: { isOpen: true, openTime: "08:00", closeTime: "18:00" } },
    });
    await Product.collection.insertOne({
      _id: product, tenant, location, createdBy: customer, name: "Test Open Studio",
      type: "workshop", kind: "open-studio", kindContractVersion: 2, bookingMode: "public",
      price: 125, extraCharge: 0, currency: "CZK", maxNumberOfParticipants: 1,
      isActive: true, isArchived: false,
    });
    await TenantPaymentAccount.collection.insertOne({ tenant, stripeAccountId: accountId, livemode: false });
    retrieveSession = vi.spyOn(getTenantPaymentStripe().checkout.sessions, "retrieve");
    expireSession = vi.spyOn(getTenantPaymentStripe().checkout.sessions, "expire")
      .mockImplementation(async () => {
        cardSession = { ...cardSession, status: "expired", url: null };
        retrieveSession.mockResolvedValue(cardSession);
        return cardSession;
      });
    createSession = vi.spyOn(getTenantPaymentStripe().checkout.sessions, "create")
      .mockImplementation(async (input: any) => {
        const session = {
          id: `cs_booking_${input.client_reference_id}`, url: "https://checkout.stripe.test/booking",
          status: "open", payment_status: "unpaid", livemode: false,
          expires_at: input.expires_at, metadata: input.metadata,
          currency: input.line_items[0].price_data.currency,
          amount_total: Number(input.metadata.expectedAmountMinor),
          client_reference_id: input.client_reference_id,
        };
        cardSession = session;
        retrieveSession.mockResolvedValue(session as never);
        return session as never;
      });
  });

  it("releases an abandoned card hold and lets the same failed credit request complete once", async () => {
    await Location.updateOne({ _id: location }, { $set: {
      "booking.allowPublicSoloOverlap": true, "booking.maxPublicSoloOverlaps": 8,
      "booking.globalCapacity": 8,
    } });
    await Product.updateOne({ _id: product }, { $set: {
      bookingMode: "customer-choice",
      openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 1, privateBookingSurcharge: 0 },
    } });
    const checkout = await checkoutService.createStripeCheckout(bookingRequest("abandoned-card"));
    const order = await Order.findById(checkout.orderId).lean();
    expect(new URL(createSession.mock.calls[0][0].cancel_url).searchParams.get("orderId"))
      .toBe(String(checkout.orderId));
    const creditRequest = bookingRequest("retry-credit-after-card");
    await expect(checkoutService.checkoutWithCredits(creditRequest))
      .rejects.toMatchObject({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" });
    expect(await balance()).toBe(initialBalance);

    const expected = { orderId: String(checkout.orderId), status: "cancelled_order", reservationReleased: true };
    await expect(cancelCheckout(checkout.orderId)).resolves.toEqual(expected);
    expect(expireSession).toHaveBeenCalledExactlyOnceWith(checkout.sessionId, { stripeAccount: accountId });
    expect(await Booking.countDocuments({ tenant })).toBe(0);
    expect(await Cart.findById(order!.cart)).toBeNull();
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({ status: "cancelled_order", isPaid: false });
    // Idempotent even after both Cart and Booking have been deleted.
    await expect(cancelCheckout(checkout.orderId)).resolves.toEqual(expected);
    expect(expireSession).toHaveBeenCalledTimes(1);

    await checkoutService.checkoutWithCredits(creditRequest);
    await checkoutService.checkoutWithCredits(creditRequest);
    expect(await balance()).toBe(25_000);
    expect(await Booking.countDocuments({ tenant, paymentStatus: "CONFIRMED" })).toBe(1);
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())!.transactions)
      .toHaveLength(1);
    expect(cardSession.status).toBe("expired");
  });

  it("does not call Stripe for another customer's or another tenant's order", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    await expect(cancelCheckout(checkout.orderId, tenant, otherCustomer))
      .rejects.toMatchObject({ code: "CHECKOUT_ORDER_NOT_FOUND" });
    await expect(cancelCheckout(checkout.orderId, otherTenant, customer))
      .rejects.toMatchObject({ code: "CHECKOUT_ORDER_NOT_FOUND" });
    expect(retrieveSession).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
  });

  it.each(["retrieve", "expire"])("keeps the hold when Stripe %s times out", async (stage) => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    (stage === "retrieve" ? retrieveSession : expireSession).mockRejectedValueOnce(new Error("timeout"));
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_PENDING" });
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({ status: "pending_order", isPaid: false });
    expect(await balance()).toBe(initialBalance);
  });

  it("protects a completed provider payment even before its webhook arrives", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    retrieveSession.mockResolvedValue({ ...cardSession, status: "complete", payment_status: "paid", payment_intent: "pi_race" });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_CONFIRMED" });
    expect(expireSession).not.toHaveBeenCalled();
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
  });

  it("protects a paid result returned by an expiration racing with payment", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    expireSession.mockResolvedValue({ ...cardSession, status: "complete", payment_status: "paid", payment_intent: "pi_race" });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_CONFIRMED" });
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
  });

  it("protects a webhook processing claim acquired after Stripe retrieval", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    expireSession.mockImplementationOnce(async () => {
      await Order.updateOne({ _id: checkout.orderId }, { $set: { "stripe.processingClaimToken": "webhook-race" } });
      return { ...cardSession, status: "expired", url: null };
    });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_PENDING" });
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({ status: "pending_order" });
  });

  it("rejects provider identity mismatches without expiring or releasing a hold", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    retrieveSession.mockResolvedValue({ ...cardSession, metadata: { ...cardSession.metadata, tenantId: String(otherTenant) } });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_PENDING" });
    expect(expireSession).not.toHaveBeenCalled();
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
  });

  it("refuses paid and already-processing orders before contacting Stripe", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    await Order.updateOne({ _id: checkout.orderId }, { $set: { "stripe.processingClaimToken": "active-claim" } });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_PENDING" });
    await Order.updateOne({ _id: checkout.orderId }, { $set: { isPaid: true } });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_PAYMENT_CONFIRMED" });
    expect(retrieveSession).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
    expect(await Booking.countDocuments({ tenant })).toBe(1);
  });

  it.each([
    { creditPurchase: { amount: 500, currency: "CZK" } },
    { legacyOrder: true },
    { bookingExtension: { bookingId: new mongoose.Types.ObjectId() } },
    { waitlist: { entryId: new mongoose.Types.ObjectId() } },
    { voucherRedemptions: [{ couponId: new mongoose.Types.ObjectId() }] },
    { courseBookings: [{ bookingId: new mongoose.Types.ObjectId(), quantity: 1 }] },
    { guestIncreaseBookings: [{ bookingId: new mongoose.Types.ObjectId(), addGuests: 1 }] },
  ])("leaves unsupported checkout flows unchanged: %j", async (unsupported) => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(checkout.orderId)) }, { $set: unsupported });
    await expect(cancelCheckout(checkout.orderId)).rejects.toMatchObject({ code: "CHECKOUT_CANCELLATION_UNSUPPORTED" });
    expect(retrieveSession).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
    expect(await booked()).toMatchObject({ paymentStatus: "PENDING_PAYMENT" });
  });

  it("confirms a signed card payment once, cancels it, and restores exactly the paid amount as usable credit", async () => {
    const request = bookingRequest();
    const checkout = await checkoutService.createStripeCheckout(request);
    const pending = await booked();
    expect(pending).toMatchObject({ status: "pending", paymentStatus: "PENDING_PAYMENT" });
    expect(await balance()).toBe(initialBalance);
    await expect(cancel(pending!._id)).rejects.toMatchObject({ code: "UNPAID_BOOKING_CANCELLATION_NOT_ALLOWED" });
    const replay = await checkoutService.createStripeCheckout(request);
    expect(String(replay.orderId)).toBe(String(checkout.orderId));
    expect(createSession).toHaveBeenCalledOnce();

    const event = paidEvent(checkout);
    await deliver(event);
    await deliver(event);
    await deliver({ ...event, id: "evt_duplicate_paid_session", type: "checkout.session.async_payment_succeeded" });
    expect(await booked()).toMatchObject({ status: "processed", paymentStatus: "CONFIRMED" });
    expect(await Booking.countDocuments({ tenant })).toBe(1);
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({
      isPaid: true, status: "processed_order", paidAmountMinor: 25_000,
    });
    expect(await balance()).toBe(initialBalance);

    // Refund the immutable paid line even if the current catalog price changes.
    await Product.updateOne({ _id: product }, { $set: { price: 999 } });
    await expect(cancel(pending!._id)).resolves.toMatchObject({ refundAmount: 250, newCreditBalance: 750, currency: "CZK" });
    expect(await booked()).toMatchObject({ status: "cancelled", accessCodeDelivery: { status: "cancelled" } });
    expect(await balance()).toBe(75_000);
    const ledger = await MoneyCredit.findOne({ tenant, user: customer }).lean();
    expect(ledger!.transactions).toHaveLength(1);
    expect(ledger!.transactions[0]).toMatchObject({ type: "refund", amountMinor: 25_000, relatedBooking: pending!._id });
    await expect(cancel(pending!._id)).rejects.toThrow("already cancelled");
    await deliver(event);
    expect(await balance()).toBe(75_000);
    expect((await booked())!.status).toBe("cancelled");
  });

  it.each([false, true])("reconciles a signed Dashboard refund and prevents new benefits/credit compensation (previously fulfilled=%s)", async (fulfilled) => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    if (fulfilled) await deliver(paidEvent(checkout));
    const pi = `pi_${checkout.sessionId}`;
    const charge: any = { id: "ch_dashboard_booking", object: "charge", payment_intent: pi, livemode: false, currency: "czk", amount: 25000, amount_refunded: 25000, paid: true };
    vi.spyOn(getTenantPaymentStripe().charges, "retrieve").mockResolvedValue(charge);
    vi.spyOn(getTenantPaymentStripe().paymentIntents, "retrieve").mockResolvedValue({ id: pi, object: "payment_intent", livemode: false, currency: "czk", amount_received: 25000, metadata: { sharioManaged: "true", orderId: String(checkout.orderId) } } as any);
    vi.spyOn(getTenantPaymentStripe().refunds, "list").mockResolvedValue({ data: [{ id: "re_dashboard_booking", object: "refund", charge: charge.id, payment_intent: pi, amount: 25000, currency: "czk", status: "succeeded" }], has_more: false } as any);
    const createRefund = vi.spyOn(getTenantPaymentStripe().refunds, "create").mockRejectedValue(new Error("Unexpected second refund"));
    retrieveSession.mockResolvedValue({ ...cardSession, payment_intent: pi, livemode: false });
    await deliver({ ...paidEvent(checkout), id: "evt_dashboard_refund", type: "charge.refunded", data: { object: charge } } as any);
    await deliver(paidEvent(checkout));
    expect(await balance()).toBe(initialBalance);
    expect(await MoneyCredit.countDocuments()).toBe(0);
    expect(await Order.findById(checkout.orderId).lean()).toMatchObject({ refund: { status: "full", succeededAmountMinor: 25000, reviewRequired: true } });
    if (fulfilled) {
      expect(await booked()).toMatchObject({ status: "processed", paymentStatus: "CONFIRMED" });
      await expect(cancel((await booked())!._id)).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
    } else expect(await booked()).toMatchObject({ status: "pending", paymentStatus: "PENDING_PAYMENT" });
    expect(createRefund).not.toHaveBeenCalled();
  });

  it("debits credits once, restores them once, and releases the slot for another booking", async () => {
    const request = bookingRequest();
    const checkout = await checkoutService.checkoutWithCredits(request);
    const booking = await booked();
    expect(checkout).toMatchObject({ success: true, amountCharged: 250, remainingCredits: 250 });
    expect(await balance()).toBe(25_000);
    expect(await booked()).toMatchObject({ status: "processed", paymentStatus: "CONFIRMED" });
    await checkoutService.checkoutWithCredits(request);
    expect(await balance()).toBe(25_000);
    expect(await Booking.countDocuments({ tenant })).toBe(1);
    await cancel(booking!._id);
    expect(await balance()).toBe(initialBalance);
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())!.transactions.map((row) => row.type))
      .toEqual(["used", "refund"]);
    await expect(cancel(booking!._id)).rejects.toThrow("already cancelled");
    user = await User.findById(customer).lean();
    await checkoutService.checkoutWithCredits(bookingRequest("booking-flow-rebook"));
    expect(await Booking.countDocuments({ tenant, status: "processed" })).toBe(1);
    expect(await balance()).toBe(25_000);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects forged or inconsistent card-payment proof without confirming or crediting", async () => {
    const checkout = await checkoutService.createStripeCheckout(bookingRequest());
    await expect(deliver(paidEvent(checkout), "whsec_wrong")).rejects.toThrow();
    await expect(deliver(paidEvent(checkout, { amount_total: 24_999 }))).rejects.toThrow();
    await deliver(paidEvent(checkout, { payment_status: "unpaid" }));
    expect(await booked()).toMatchObject({ status: "pending", paymentStatus: "PENDING_PAYMENT" });
    expect(await balance()).toBe(initialBalance);
    expect(await MoneyCredit.countDocuments()).toBe(0);
  });

  it("keeps other tenants and customers from cancelling or receiving the refund", async () => {
    await checkoutService.checkoutWithCredits(bookingRequest());
    const booking = await booked();
    await expect(cancel(booking!._id, otherTenant, otherCustomer)).rejects.toThrow("Booking not found");
    await expect(cancel(booking!._id, tenant, otherCustomer)).rejects.toThrow("only cancel your own");
    expect(await booked()).toMatchObject({ status: "processed" });
    expect(await balance()).toBe(25_000);
    expect((await User.findById(otherCustomer).lean())!.moneyCreditsMinor).toBe(0);
  });

  it("rolls cancellation back if restoring the ledger fails, then succeeds safely on retry", async () => {
    await checkoutService.checkoutWithCredits(bookingRequest());
    const booking = await booked();
    vi.spyOn(MoneyCredit.prototype, "save").mockRejectedValueOnce(new Error("Ledger unavailable"));
    await expect(cancel(booking!._id)).rejects.toThrow("Ledger unavailable");
    expect(await booked()).toMatchObject({ status: "processed", paymentStatus: "CONFIRMED" });
    expect(await balance()).toBe(25_000);
    await cancel(booking!._id);
    expect(await balance()).toBe(initialBalance);
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())!.transactions).toHaveLength(2);
  });

  it("serializes concurrent cancellation requests without restoring credit twice", async () => {
    await checkoutService.checkoutWithCredits(bookingRequest());
    const booking = await booked();
    const outcomes = await Promise.allSettled([cancel(booking!._id), cancel(booking!._id)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await balance()).toBe(initialBalance);
    expect((await booked())!.status).toBe("cancelled");
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())!.transactions).toHaveLength(2);
  });

  it("refuses cancellation once an access code was issued without changing the booking or balance", async () => {
    await checkoutService.checkoutWithCredits(bookingRequest());
    const booking = await booked();
    await Booking.updateOne({ _id: booking!._id }, { $set: { "accessCodeDelivery.status": "sent" } });
    await expect(cancel(booking!._id)).rejects.toMatchObject({ code: "BOOKING_ACCESS_ALREADY_ISSUED" });
    expect(await booked()).toMatchObject({ status: "processed", accessCodeDelivery: { status: "sent" } });
    expect(await balance()).toBe(25_000);
    expect((await MoneyCredit.findOne({ tenant, user: customer }).lean())!.transactions).toHaveLength(1);
  });
});
