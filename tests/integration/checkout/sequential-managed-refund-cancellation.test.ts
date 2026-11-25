import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Keep cancellation, voucher restoration, the card-refund outbox, signature
// verification and Connect reconciliation real. Only provider I/O and delivery
// are replaced; these tests must pass through both public cancellation services.
const delivery = vi.hoisted(() => ({ enqueue: vi.fn(), promote: vi.fn() }));
vi.mock("@/infrastructure/queues/communication-email.queue.js", () => ({
  enqueueCommunicationEmail: delivery.enqueue,
}));
vi.mock("@/modules/waitlist/waitlist.service.js", () => ({ promoteWaitlistEntry: delivery.promote }));
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

import Booking from "@/modules/booking/booking.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import { cancelBookingWithRefund } from "@/modules/booking/services/booking.refund.service.js";
import { cancelPaidCourseParticipants } from "@/modules/booking/services/booking.course-participant-cancellation.service.js";
import { processBookingPaymentRefunds } from "@/modules/booking/services/booking-payment-refund.service.js";
import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import Location from "@/modules/location/location.model.js";
import { MoneyCredit } from "@/modules/money-credit/money-credit.model.js";
import { Order } from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Account from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import { PaymentRefundObservation, PaymentRefundReconciliation, PaymentRefundReviewResolution } from "@/modules/tenant-payments/payment-refund-reconciliation.model.js";
import { constructTenantPaymentConnectEvent, getTenantPaymentStripe } from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";
import { handleTenantPaymentConnectEvent } from "@/modules/tenant-payments/services/tenant-payment-connect.webhook.service.js";
import User from "@/modules/user/user.model.js";
import { WaitlistAuditModel } from "@/modules/waitlist/waitlist.model.js";

const tenant = new mongoose.Types.ObjectId();
const customer = new mongoose.Types.ObjectId();
const staff = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const unrelatedOrder = new mongoose.Types.ObjectId();
const bookingIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
const accountId = "acct_sequential_refund";
const paymentIntentId = "pi_sequential_refund";
const chargeId = "ch_sequential_refund";
const secret = "whsec_sequential_refund";
const expiry = new Date("2035-01-01T00:00:00Z");
const models = [Booking, BookingPaymentRefund, AccessCodeNotification, Cart,
  CommunicationEmailLogModel, Coupon, VoucherLedger, VoucherReservation, Location,
  MoneyCredit, Order, Product, Tenant, Account, PaymentRefundObservation,
  PaymentRefundReconciliation, PaymentRefundReviewResolution, User, WaitlistAuditModel];
type CancellationKind = "open-studio" | "class";
let replica: MongoMemoryReplSet;
let providerRefunds: any[];
let createRefund: ReturnType<typeof vi.spyOn>;

const cancel = (kind: CancellationKind, bookingId: mongoose.Types.ObjectId) =>
  kind === "open-studio"
    ? cancelBookingWithRefund({ tenantId: String(tenant), userId: String(customer), bookingId: String(bookingId) })
    : cancelPaidCourseParticipants({ tenantId: String(tenant), orderId: String(orderId),
      sessionId: String(bookingId), actorUserId: String(staff), reason: "Customer requested cancellation" });

async function deliverRefund(eventId: string) {
  const payload = JSON.stringify({ id: eventId, object: "event", type: "charge.refunded",
    account: accountId, livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { object: "charge", id: chargeId, payment_intent: paymentIntentId,
      livemode: false, paid: true, currency: "czk", amount: 15000,
      amount_refunded: providerRefunds.reduce((sum, refund) => sum + refund.amount, 0) } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  await handleTenantPaymentConnectEvent(constructTenantPaymentConnectEvent(Buffer.from(payload), signature));
}

async function seedPaidReservations(kind: CancellationKind) {
  const coupon = await Coupon.create({ tenant, product, promoCode: "SEQUENTIAL-REFUND",
    valueMinorSnapshot: 15000, currencySnapshot: "CZK", lifecycleVersion: 1,
    voucherTypeSnapshot: "value", remainingValueMinor: 15000, expiresAt: expiry,
    voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "months", months: 12 } } });
  const redemptions = [5000, 10000].map((amountMinor, lineIndex) => ({
    couponId: coupon._id, reservationId: `checkout:${orderId}:voucher:${lineIndex}`,
    lineIndex, amountMinor, quantity: 0, appliedAmountMinor: amountMinor, eligibleProductId: product,
  }));
  for (const row of redemptions) {
    await voucherLifecycleService.reserve({ tenantId: String(tenant), couponId: coupon._id,
      operationId: row.reservationId, referenceId: String(orderId), amountMinor: row.amountMinor,
      currency: "CZK", eligibleProductId: String(product) });
    await voucherLifecycleService.commit({ tenantId: String(tenant), couponId: coupon._id,
      reservationId: row.reservationId, operationId: `${row.reservationId}:commit`,
      referenceId: String(orderId), currency: "CZK", paymentState: "paid" });
  }
  await Order.create({ _id: orderId, cart: new mongoose.Types.ObjectId(), tenant,
    createdBy: customer, customer: { firstname: "Refund", lastname: "Customer" },
    isPaid: true, status: "processed_order", currency: "CZK", grossAmountMinor: 30000,
    expectedAmountMinor: 15000, paidAmountMinor: 15000, voucherRedemptions: redemptions,
    workshopBookings: kind === "open-studio" ? bookingIds : [],
    courseBookings: kind === "class" ? bookingIds.map((bookingId) => ({ bookingId, quantity: 1, capacityReserved: true })) : [],
    lineItems: bookingIds.map((booking, index) => ({ booking, product, description: "Reservation",
      quantity: 1, unitGrossMinor: (index + 1) * 10000, grossAmountMinor: (index + 1) * 10000,
      netAmountMinor: (index + 1) * 10000, taxAmountMinor: 0, taxRateBps: 0, locationIds: [location] })),
    paymentAllocations: [{ method: "voucher", amountMinor: 15000 }, { method: "stripe", amountMinor: 15000 }],
    stripe: { connectedAccountId: accountId, livemode: false, paymentIntentId, sessionId: "cs_sequential_refund" },
  });
  for (const [index, bookingId] of bookingIds.entries()) {
    await Booking.create({ _id: bookingId, tenant, location, createdBy: kind === "class" ? staff : customer,
      bookingProduct: product, author: { name: "Refund customer", customId: "REFUND-CUSTOMER" },
      orders: kind === "class" ? [orderId, unrelatedOrder] : [orderId],
      participants: kind === "class" ? [
        { firstname: "Refund", lastname: "Customer", order: orderId },
        { firstname: "Unaffected", lastname: "Customer", order: unrelatedOrder },
      ] : [],
      start: new Date(`2030-01-0${index + 7}T10:00:00Z`), end: new Date(`2030-01-0${index + 7}T11:00:00Z`),
      numberOfHours: 1, numberOfGuests: kind === "class" ? 2 : 1,
      tag: kind, status: "processed", paymentStatus: "CONFIRMED",
    });
  }
  return coupon;
}

describe("sequential cancellation after a managed card refund webhook", () => {
  beforeAll(async () => {
    vi.stubEnv("STRIPE_KEY", "sk_test_sequential_refund");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", secret);
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await mongoose.disconnect();
    await replica?.stop();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delivery.enqueue.mockResolvedValue({ queueAccepted: true, state: "waiting" });
    delivery.promote.mockResolvedValue(null);
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await Tenant.collection.insertOne({ _id: tenant, slug: "sequential-refund", plan: "studio_plus",
      planVersion: 3, settings: { currency: "CZK", defaultLanguage: "en" } } as any);
    await User.collection.insertOne({ _id: customer, tenant, firstname: "Refund", lastname: "Customer",
      email: "refund@example.test", customId: "REFUND-CUSTOMER", memberNumber: 42,
      tenantRole: "customer", platformRole: "none", moneyCredits: 0, moneyCreditsMinor: 0 } as any);
    await Location.collection.insertOne({ _id: location, tenant, name: "Refund studio", booking: { timezone: "UTC" } } as any);
    await Product.collection.insertOne({ _id: product, tenant, location, name: "Reservation", price: 100, currency: "CZK" } as any);
    await Account.create({ tenant, stripeAccountId: accountId, accountCreateIdempotencyKey: "fixture", livemode: false });
    providerRefunds = [];
    const stripe = getTenantPaymentStripe();
    vi.spyOn(stripe.paymentIntents, "retrieve").mockResolvedValue({ id: paymentIntentId,
      object: "payment_intent", status: "succeeded", amount: 15000, amount_received: 15000,
      currency: "czk", livemode: false, metadata: {} } as any);
    vi.spyOn(stripe.charges, "retrieve").mockImplementation(async () => ({ id: chargeId,
      object: "charge", payment_intent: paymentIntentId, paid: true, livemode: false,
      currency: "czk", amount: 15000,
      amount_refunded: providerRefunds.reduce((sum, refund) => sum + refund.amount, 0) } as any));
    vi.spyOn(stripe.refunds, "list").mockImplementation((async () => ({
      data: structuredClone(providerRefunds), has_more: false,
    })) as never);
    createRefund = vi.spyOn(stripe.refunds, "create").mockImplementation(async (params: any) => {
      const refund = { id: `re_sequential_${providerRefunds.length + 1}`, object: "refund",
        status: "succeeded", amount: params.amount, currency: "czk", payment_intent: paymentIntentId,
        charge: chargeId, metadata: params.metadata };
      providerRefunds.push(refund);
      return structuredClone(refund) as any;
    });
  });

  it.each([
    { kind: "open-studio" as const, earlyWebhook: false },
    { kind: "class" as const, earlyWebhook: false },
    { kind: "open-studio" as const, earlyWebhook: true },
    { kind: "class" as const, earlyWebhook: true },
  ])(
    "cancels the second $kind reservation once after the first refund (webhook before worker save=$earlyWebhook)",
    async ({ kind, earlyWebhook }) => {
      const coupon = await seedPaidReservations(kind);
      await cancel(kind, bookingIds[0]);
      if (earlyWebhook) {
        const providerCreate = createRefund.getMockImplementation() as (...args: any[]) => Promise<any>;
        createRefund.mockImplementationOnce(async (...args: any[]) => {
          const refund = await providerCreate(...args);
          // Stripe can deliver its signed event while the worker is still
          // awaiting refunds.create and has not persisted the returned ID.
          await deliverRefund("evt_first_managed_refund");
          expect(await BookingPaymentRefund.findOne({ tenant, booking: bookingIds[0] }).lean())
            .toMatchObject({ status: "processing", refundId: "", claimToken: expect.any(String) });
          await expect(cancel(kind, bookingIds[1])).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
          expect((await Coupon.findById(coupon._id).lean())?.remainingValueMinor).toBe(5000);
          expect(await BookingPaymentRefund.countDocuments({ tenant })).toBe(1);
          expect(await VoucherLedger.countDocuments({ tenant, kind: "reverse" })).toBe(1);
          expect(await CommunicationEmailLogModel.countDocuments({ tenant })).toBe(1);
          return refund;
        });
      }
      expect(await processBookingPaymentRefunds()).toEqual({ processed: 1 });
      expect(await BookingPaymentRefund.findOne({ tenant, booking: bookingIds[0] }).lean())
        .toMatchObject({ status: "succeeded", refundId: "re_sequential_1", claimToken: "" });
      if (!earlyWebhook) {
        await deliverRefund("evt_first_managed_refund");
        await deliverRefund("evt_first_managed_refund");
      }
      expect((await Order.findById(orderId).lean())?.refund?.succeededAmountMinor).toBe(5000);
      expect(await PaymentRefundObservation.countDocuments({ tenant })).toBe(1);

      // Regression: the first managed refund used to block this legitimate
      // second cancellation merely because both reservations share an order.
      // For early delivery, no second webhook repairs the state after the
      // worker commits: the persisted managed-refund proof alone must suffice.
      await cancel(kind, bookingIds[1]);
      for (const bookingId of bookingIds) {
        await expect(cancel(kind, bookingId)).resolves.toMatchObject({ idempotent: true });
      }
      expect(await processBookingPaymentRefunds()).toEqual({ processed: 1 });
      await deliverRefund("evt_second_managed_refund");
      await deliverRefund("evt_second_managed_refund");
      expect(await processBookingPaymentRefunds()).toEqual({ processed: 0 });
      expect(createRefund).toHaveBeenCalledTimes(2);
      expect(createRefund.mock.calls.map(([params]) => (params as any).amount)).toEqual([5000, 10000]);
      expect(await BookingPaymentRefund.find({ tenant }).sort({ cardAmountMinor: 1 }).lean()).toMatchObject([
        { booking: bookingIds[0], status: "succeeded", amountMinor: 10000, voucherAmountMinor: 5000, cardAmountMinor: 5000 },
        { booking: bookingIds[1], status: "succeeded", amountMinor: 20000, voucherAmountMinor: 10000, cardAmountMinor: 10000 },
      ]);
      expect(await Coupon.findById(coupon._id).lean()).toMatchObject({ remainingValueMinor: 15000, expiresAt: expiry });
      expect(await VoucherLedger.countDocuments({ tenant, kind: "reverse" })).toBe(2);
      expect(await MoneyCredit.countDocuments({ tenant })).toBe(0);
      expect((await User.findById(customer).lean())?.moneyCreditsMinor).toBe(0);
      expect(await CommunicationEmailLogModel.countDocuments({ tenant })).toBe(2);
      expect((await Order.findById(orderId).lean())?.refund).toMatchObject({ status: "full", succeededAmountMinor: 15000 });
      expect(await PaymentRefundObservation.countDocuments({ tenant })).toBe(2);
      for (const bookingId of bookingIds) {
        expect(await Booking.findById(bookingId).lean()).toMatchObject(kind === "class"
          ? { status: "processed", numberOfGuests: 1, participants: [{ order: unrelatedOrder }] }
          : { status: "cancelled" });
      }
      if (kind === "class") {
        expect((await Order.findById(orderId).lean())?.courseCancellations).toHaveLength(2);
        expect(await WaitlistAuditModel.countDocuments({ tenant })).toBe(2);
        expect(delivery.promote).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each<CancellationKind>(["open-studio", "class"])(
    "still blocks the second %s cancellation when Dashboard adds an unallocated refund",
    async (kind) => {
      const coupon = await seedPaidReservations(kind);
      await cancel(kind, bookingIds[0]);
      await processBookingPaymentRefunds();
      providerRefunds.push({ id: "re_external", object: "refund", status: "succeeded",
        amount: 1000, currency: "czk", payment_intent: paymentIntentId, charge: chargeId, metadata: {} });
      await deliverRefund("evt_external_plus_managed");
      await expect(cancel(kind, bookingIds[1])).rejects.toMatchObject({ code: "PAYMENT_REFUND_REVIEW_REQUIRED" });
      expect(await Booking.findById(bookingIds[1]).lean()).toMatchObject({ status: "processed", numberOfGuests: kind === "class" ? 2 : 1 });
      expect((await Coupon.findById(coupon._id).lean())?.remainingValueMinor).toBe(5000);
      expect(await BookingPaymentRefund.countDocuments({ tenant })).toBe(1);
      expect(await VoucherLedger.countDocuments({ tenant, kind: "reverse" })).toBe(1);
      expect(await CommunicationEmailLogModel.countDocuments({ tenant })).toBe(1);
      expect(createRefund).toHaveBeenCalledTimes(1);
    },
  );
});
