import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { Cart } from "@/modules/cart/cart.model.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import {
  commitCheckoutVouchers,
  getVoucherCheckoutPlan,
  reserveCheckoutVouchers,
} from "@/modules/checkout/services/checkout.voucher.service.js";
import { processWorkshopBookingsAfterPayment } from "@/modules/checkout/services/checkout.workshop-fulfillment.service.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import {
  VoucherLedger,
  VoucherReservation,
} from "@/modules/coupon/voucher-ledger.model.js";
import { LocationModel } from "@/modules/location/location.model.js";
import { Order } from "@/modules/order/order.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";

// Exercise the real persisted checkout boundary and its repository adapters.
// HTTP authentication, Stripe signatures, remote Session creation and the
// surrounding checkout orchestrator are covered separately by unit tests.
// No Stripe client or notification transport is invoked in this suite.
let replicaSet: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const actor = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const ACCOUNT = "acct_voucher_booking";
const GROSS = 12_100;
const models = [
  TenantModel,
  Coupon,
  VoucherLedger,
  VoucherReservation,
  Order,
  Booking,
  LocationModel,
  Cart,
];

async function valueCoupon(valueMinor = 15_000) {
  return Coupon.create({
    tenant,
    product,
    promoCode: "BOOKING-VOUCHER-001",
    lifecycleVersion: 1,
    voucherTypeSnapshot: "value",
    currencySnapshot: "CZK",
    valueMinorSnapshot: valueMinor,
    remainingValueMinor: valueMinor,
    voucherSettingsSnapshot: {
      version: 1,
      type: "value",
      validity: { mode: "months", months: 12 },
    },
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

function pendingBooking(
  orderId: mongoose.Types.ObjectId,
  bookingId: mongoose.Types.ObjectId,
  expired = false,
) {
  return {
    _id: bookingId,
    tenant,
    location,
    createdBy: actor,
    orders: [orderId],
    bookingProduct: product,
    author: { name: "Voucher buyer", customId: "TEST-1" },
    numberOfHours: 1,
    numberOfGuests: 1,
    start: new Date(Date.now() + 86_400_000),
    end: new Date(Date.now() + 90_000_000),
    status: "pending" as const,
    paymentStatus: "PENDING_PAYMENT" as const,
    tag: "workshop" as const,
    bookingType: "private" as const,
    plannedActivity: "UNDEFINED" as const,
    paymentExpiresAt: new Date(Date.now() + (expired ? -60_000 : 3_600_000)),
  };
}

async function prepareCheckout(
  coupon: any,
  { fullyPaid = false, expiredBooking = false } = {},
) {
  const orderId = new mongoose.Types.ObjectId();
  const bookingId = new mongoose.Types.ObjectId();
  const lineItems = [
    {
      product,
      booking: bookingId,
      description: "Studio booking",
      sku: "STUDIO",
      quantity: 1,
      unitGrossMinor: GROSS,
      grossAmountMinor: GROSS,
      netAmountMinor: 10_000,
      taxAmountMinor: 2_100,
      taxRateBps: 2_100,
      locationIds: [location],
    },
  ];
  await mongoose.connection.transaction(async (session) => {
    const plan = await getVoucherCheckoutPlan({
      tenantId: String(tenant),
      voucherCode: coupon.promoCode,
      lineItems,
      currency: "CZK",
      orderId: String(orderId),
      session,
    });
    await reserveCheckoutVouchers({
      tenantId: String(tenant),
      userId: String(actor),
      orderId: String(orderId),
      currency: "CZK",
      allocations: plan.allocations,
      session,
      reviewAfter: new Date(Date.now() + 3_600_000),
    });
    const order = await checkoutRepository.createOrder({
      tenantId: tenant,
      session,
      payload: {
        _id: orderId,
        cart: new mongoose.Types.ObjectId(),
        createdBy: actor,
        currency: "CZK",
        grossAmountMinor: GROSS,
        expectedAmountMinor: plan.remainingToPayMinor,
        lineItems,
        voucherRedemptions: plan.allocations,
        paymentAllocations: [
          {
            method: "voucher",
            amountMinor: plan.voucherAppliedMinor,
            providerReference: String(coupon._id),
          },
        ],
        workshopBookings: [bookingId],
        stripe: { connectedAccountId: ACCOUNT },
      },
    });
    await checkoutRepository.createBookings({
      tenantId: tenant,
      payloads: [pendingBooking(orderId, bookingId, expiredBooking)],
      atomicCapacity: true,
      session,
    });
    if (fullyPaid) {
      expect(plan.remainingToPayMinor).toBe(0);
      await commitCheckoutVouchers({
        tenantId: String(tenant),
        order,
        paymentState: "not_required",
        session,
      });
      await processWorkshopBookingsAfterPayment(order, {
        tenantId: tenant,
        session,
      });
      await Order.updateOne(
        { tenant, _id: orderId },
        {
          $set: {
            status: "processed_order",
            isPaid: true,
            paidAt: new Date(),
            paidAmountMinor: 0,
          },
        },
        { session },
      ).exec();
    }
  });
  return (await Order.findById(orderId).lean().exec())!;
}

async function attachCard(order: any) {
  const sessionId = `cs_booking_${order._id}`;
  await checkoutRepository.attachStripeSession({
    tenantId: tenant,
    orderId: order._id,
    sessionId,
    amountMinor: order.expectedAmountMinor,
    currency: "CZK",
    connectedAccountId: ACCOUNT,
    livemode: false,
  });
  return {
    id: sessionId,
    payment_intent: `pi_booking_${order._id}`,
    currency: "czk",
    amount_total: order.expectedAmountMinor,
    connectedAccountId: ACCOUNT,
    livemode: false,
  };
}

function claim(
  order: any,
  providerSession: Awaited<ReturnType<typeof attachCard>>,
  overrides: Record<string, any> = {},
) {
  const now = new Date();
  return checkoutRepository.claimStripeOrder({
    tenantId: tenant,
    orderId: order._id,
    eventId: "evt_booking_paid",
    claimToken: "claim-booking",
    now,
    leaseExpiresAt: new Date(now.getTime() + 300_000),
    session: providerSession,
    ...overrides,
  });
}

async function finalize(claimed: any, claimToken = "claim-booking") {
  await mongoose.connection.transaction(async (session) => {
    await commitCheckoutVouchers({
      tenantId: String(tenant),
      order: claimed,
      paymentState: "paid",
      session,
    });
    await processWorkshopBookingsAfterPayment(claimed, {
      tenantId: tenant,
      session,
    });
    const changed = await checkoutRepository.markOrderProcessed({
      tenantId: tenant,
      orderId: claimed._id,
      eventId: "evt_booking_paid",
      claimToken,
      paidAt: claimed.paidAt,
      session,
    });
    if (changed.modifiedCount !== 1)
      throw new Error("Checkout claim was lost.");
  });
}

describe("voucher booking checkout persisted transaction boundary", () => {
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await TenantModel.collection.insertMany([
      { _id: tenant, slug: "voucher-checkout-tenant" },
      { _id: otherTenant, slug: "other-voucher-checkout-tenant" },
    ]);
    await LocationModel.collection.insertOne({
      _id: location,
      tenant,
      isActive: true,
      booking: {
        enabled: true,
        globalCapacity: 1,
        activitySelectionMode: "HIDDEN",
        capacityRevision: 0,
      },
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (replicaSet) await replicaSet.stop();
  });

  it("commits a full voucher payment, its booking and full-value order together", async () => {
    const coupon = await valueCoupon();
    const order = await prepareCheckout(coupon, { fullyPaid: true });
    expect(order).toMatchObject({
      grossAmountMinor: GROSS,
      expectedAmountMinor: 0,
      paidAmountMinor: 0,
      isPaid: true,
      status: "processed_order",
      paymentAllocations: [
        expect.objectContaining({ method: "voucher", amountMinor: GROSS }),
      ],
    });
    expect(await Booking.findOne({ orders: order._id }).lean()).toMatchObject({
      status: "processed",
      paymentStatus: "CONFIRMED",
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 2_900,
      reservedValueMinor: 0,
    });
    expect(await VoucherReservation.findOne().lean()).toMatchObject({
      status: "committed",
      amountMinor: GROSS,
    });
    expect(await VoucherLedger.countDocuments({ kind: "commit" })).toBe(1);
  });

  it("rolls back the voucher hold and saved order if actual location capacity rejects the booking", async () => {
    const coupon = await valueCoupon();
    await Booking.create({
      ...pendingBooking(
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ),
      status: "processed",
      paymentStatus: "CONFIRMED",
    });
    await expect(
      prepareCheckout(coupon, { fullyPaid: true }),
    ).rejects.toMatchObject({ code: "LOCATION_OVERLAP_NOT_ALLOWED" });
    expect(await Order.countDocuments()).toBe(0);
    expect(await Booking.countDocuments()).toBe(1);
    expect(await VoucherReservation.countDocuments()).toBe(0);
    expect(await VoucherLedger.countDocuments()).toBe(0);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 15_000,
      reservedValueMinor: 0,
    });
  });

  it("holds mixed-payment value until a matching payment claim and commits once across duplicate confirmations", async () => {
    const coupon = await valueCoupon(5_000);
    const order = await prepareCheckout(coupon);
    const providerSession = await attachCard(order);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 5_000,
      reservedValueMinor: 5_000,
    });
    expect(
      await claim(order, providerSession, { tenantId: otherTenant }),
    ).toBeNull();
    expect(
      await claim(order, { ...providerSession, amount_total: GROSS }),
    ).toBeNull();
    expect(
      await claim(order, {
        ...providerSession,
        connectedAccountId: "acct_other",
      }),
    ).toBeNull();
    expect(
      await claim(order, { ...providerSession, livemode: true }),
    ).toBeNull();
    const results = await Promise.all([
      claim(order, providerSession),
      claim(order, providerSession, {
        claimToken: "claim-duplicate",
        eventId: "evt_duplicate",
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find(Boolean)!;
    await finalize(winner, results[0] ? "claim-booking" : "claim-duplicate");
    const saved = (await Order.findById(order._id).lean())!;
    await mongoose.connection.transaction((session) =>
      commitCheckoutVouchers({
        tenantId: String(tenant),
        order: saved,
        paymentState: "paid",
        session,
      }),
    );
    expect(
      await claim(order, providerSession, { eventId: "evt_later_duplicate" }),
    ).toBeNull();
    expect(saved).toMatchObject({
      grossAmountMinor: GROSS,
      expectedAmountMinor: 7_100,
      paidAmountMinor: 7_100,
      status: "processed_order",
    });
    expect(
      saved.paymentAllocations.map((row) => [row.method, row.amountMinor]),
    ).toEqual([
      ["stripe", 7_100],
      ["voucher", 5_000],
    ]);
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 0,
      reservedValueMinor: 0,
      isActive: false,
    });
    expect(await VoucherLedger.countDocuments({ kind: "commit" })).toBe(1);
    expect(
      await Booking.countDocuments({
        orders: order._id,
        paymentStatus: "CONFIRMED",
      }),
    ).toBe(1);
  });

  it("rolls back voucher consumption if paid booking fulfillment fails, preserving a retryable hold", async () => {
    const coupon = await valueCoupon(5_000);
    const order = await prepareCheckout(coupon, { expiredBooking: true });
    const providerSession = await attachCard(order);
    const claimed = await claim(order, providerSession);
    await expect(finalize(claimed)).rejects.toThrow("could be confirmed");
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 5_000,
      reservedValueMinor: 5_000,
    });
    expect(await VoucherLedger.countDocuments({ kind: "commit" })).toBe(0);
    expect(await Order.findById(order._id).lean()).toMatchObject({
      isPaid: true,
      status: "pending_order",
    });
    await Booking.updateOne(
      { orders: order._id, tenant },
      { $set: { paymentExpiresAt: new Date(Date.now() + 60_000) } },
    );
    await finalize(claimed);
    expect(await Order.findById(order._id).lean()).toMatchObject({
      status: "processed_order",
    });
    expect(await VoucherLedger.countDocuments({ kind: "commit" })).toBe(1);
  });

  it("releases an attached expired Session once and ignores mismatched tenant/account/session events", async () => {
    const coupon = await valueCoupon(5_000);
    const order = await prepareCheckout(coupon);
    const providerSession = await attachCard(order);
    const input = {
      tenantId: tenant,
      orderId: order._id,
      sessionId: providerSession.id,
      connectedAccountId: ACCOUNT,
    };
    expect(
      await checkoutRepository.releaseExpiredStripeOrder({
        ...input,
        tenantId: otherTenant,
      }),
    ).toBe(false);
    expect(
      await checkoutRepository.releaseExpiredStripeOrder({
        ...input,
        connectedAccountId: "acct_other",
      }),
    ).toBe(false);
    expect(
      await checkoutRepository.releaseExpiredStripeOrder({
        ...input,
        sessionId: "cs_other",
      }),
    ).toBe(false);
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(5_000);
    await checkoutRepository.releaseExpiredStripeOrder(input);
    await checkoutRepository.releaseExpiredStripeOrder(input);
    expect(await Order.findById(order._id).lean()).toMatchObject({
      status: "cancelled_order",
      isPaid: false,
    });
    expect(await Coupon.findById(coupon._id).lean()).toMatchObject({
      remainingValueMinor: 5_000,
      reservedValueMinor: 0,
    });
    expect(await VoucherLedger.countDocuments({ kind: "release" })).toBe(1);
    expect(await Booking.countDocuments({ orders: order._id })).toBe(0);
    expect(await claim(order, providerSession)).toBeNull();
  });

  it("never releases a held voucher after payment has won the expiry race", async () => {
    const coupon = await valueCoupon(5_000);
    const order = await prepareCheckout(coupon);
    const providerSession = await attachCard(order);
    const claimed = await claim(order, providerSession);
    expect(
      await checkoutRepository.releaseExpiredStripeOrder({
        tenantId: tenant,
        orderId: order._id,
        sessionId: providerSession.id,
        connectedAccountId: ACCOUNT,
      }),
    ).toBe(false);
    expect((await Coupon.findById(coupon._id))?.reservedValueMinor).toBe(5_000);
    await finalize(claimed);
    expect(await VoucherLedger.countDocuments({ kind: "release" })).toBe(0);
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(0);
  });
});
