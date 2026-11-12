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

const provider = vi.hoisted(() => ({
  retrieve: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getTenantPaymentStripe: () => ({
    paymentIntents: { retrieve: provider.retrieve },
    refunds: { list: provider.list, create: provider.create },
  }),
  getTenantPaymentStripeLivemode: () => false,
  getConnectedAccountRequestOptions: (account: string) => ({
    stripeAccount: account,
  }),
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
        price: Number,
      }),
    );
  return { default: Product, Product };
});
import { Coupon } from "@/modules/coupon/coupon.model.js";
import {
  VoucherLedger,
  VoucherReservation,
} from "@/modules/coupon/voucher-ledger.model.js";
import { voucherLifecycleService } from "@/modules/coupon/voucher-lifecycle.service.js";
import { Order } from "@/modules/order/order.model.js";
import { BookingPaymentRefund } from "@/modules/booking/booking-payment-refund.model.js";
import {
  processBookingPaymentRefunds,
  processBookingPaymentRefundEvent,
  refundBookingOriginalPaymentInSession,
} from "@/modules/booking/services/booking-payment-refund.service.js";

let replica: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const order = new mongoose.Types.ObjectId();
const booking = new mongoose.Types.ObjectId();
const secondBooking = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const inputs = (bookingId = booking) => ({
  tenantId: String(tenant),
  orderId: String(order),
  bookingId: String(bookingId),
  actorId: String(user),
  reason: "Booking cancelled",
});

async function seedPaidOrder() {
  const coupon = await Coupon.create({
    tenant,
    product,
    promoCode: "REFUND-INTEGRATION",
    valueMinorSnapshot: 15000,
    currencySnapshot: "CZK",
    lifecycleVersion: 1,
    voucherTypeSnapshot: "value",
    remainingValueMinor: 15000,
    expiresAt: new Date(Date.now() + 86_400_000),
    voucherSettingsSnapshot: {
      version: 1,
      type: "value",
      validity: { mode: "months", months: 12 },
    },
  });
  const redemptions = [5000, 10000].map((amountMinor, lineIndex) => ({
    couponId: coupon._id,
    reservationId: `checkout:${order}:voucher:${lineIndex}`,
    lineIndex,
    amountMinor,
    quantity: 0,
    appliedAmountMinor: amountMinor,
    eligibleProductId: product,
  }));
  for (const row of redemptions) {
    await voucherLifecycleService.reserve({
      tenantId: String(tenant),
      couponId: coupon._id,
      operationId: row.reservationId,
      referenceId: String(order),
      amountMinor: row.amountMinor,
      currency: "CZK",
      eligibleProductId: String(product),
    });
    await voucherLifecycleService.commit({
      tenantId: String(tenant),
      couponId: coupon._id,
      reservationId: row.reservationId,
      operationId: `${row.reservationId}:commit`,
      referenceId: String(order),
      currency: "CZK",
      paymentState: "paid",
    });
  }
  await Order.collection.insertOne({
    _id: order,
    tenant,
    createdBy: user,
    isPaid: true,
    status: "processed_order",
    currency: "CZK",
    grossAmountMinor: 30000,
    expectedAmountMinor: 15000,
    lineItems: [
      { booking, grossAmountMinor: 10000 },
      { booking: secondBooking, grossAmountMinor: 20000 },
    ],
    voucherRedemptions: redemptions,
    paymentAllocations: [
      { method: "voucher", amountMinor: 15000 },
      { method: "stripe", amountMinor: 15000 },
    ],
    stripe: {
      connectedAccountId: "acct_original",
      livemode: false,
      paymentIntentId: "pi_original",
    },
  } as any);
  await mongoose.connection
    .collection("booking_refund_fixture")
    .insertOne({ _id: booking, tenant, status: "confirmed" });
  return coupon;
}

describe("booking voucher/card refunds with MongoDB transactions", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all([
      Coupon.createCollection(),
      VoucherLedger.createCollection(),
      VoucherReservation.createCollection(),
      Order.createCollection(),
      BookingPaymentRefund.createCollection(),
      mongoose.connection.createCollection("tenants"),
      mongoose.connection.createCollection("booking_refund_fixture"),
    ]);
  }, 60000);
  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      [
        Coupon,
        VoucherLedger,
        VoucherReservation,
        Order,
        BookingPaymentRefund,
      ].map((model) => model.collection.deleteMany({})),
    );
    await mongoose.connection.collection("tenants").deleteMany({});
    await mongoose.connection
      .collection("tenants")
      .insertMany([{ _id: tenant }, { _id: otherTenant }]);
    await mongoose.connection
      .collection("booking_refund_fixture")
      .deleteMany({});
    provider.retrieve.mockResolvedValue({
      id: "pi_original",
      status: "succeeded",
      amount: 15000,
      amount_received: 15000,
      currency: "czk",
      livemode: false,
    });
    provider.list.mockResolvedValue({ data: [], has_more: false });
    provider.create.mockImplementation(async (params: any) => ({
      id: "re_saved",
      status: "succeeded",
      amount: params.amount,
      currency: "czk",
      payment_intent: "pi_original",
      metadata: params.metadata,
    }));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    if (replica) await replica.stop();
  });

  it("rolls back cancellation, voucher restoration and refund intent together when the outbox cannot be saved", async () => {
    const coupon = await seedPaidOrder();
    const fail = vi
      .spyOn(BookingPaymentRefund, "create")
      .mockRejectedValueOnce(new Error("Outbox unavailable"));
    await expect(
      mongoose.connection.transaction(async (session) => {
        await mongoose.connection
          .collection("booking_refund_fixture")
          .updateOne(
            { _id: booking, tenant },
            { $set: { status: "cancelled" } },
            { session },
          );
        await refundBookingOriginalPaymentInSession({ ...inputs(), session });
      }),
    ).rejects.toThrow("Outbox unavailable");
    fail.mockRestore();
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(0);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(0);
    expect(await BookingPaymentRefund.countDocuments()).toBe(0);
    expect(
      await mongoose.connection
        .collection("booking_refund_fixture")
        .findOne({ _id: booking }),
    ).toMatchObject({ status: "confirmed" });
  });
  it("serializes simultaneous repeated cancellation and returns only the cancelled session's original sources", async () => {
    const coupon = await seedPaidOrder();
    const results = await Promise.all(
      [0, 1].map(() =>
        mongoose.connection.transaction((session) =>
          refundBookingOriginalPaymentInSession({ ...inputs(), session }),
        ),
      ),
    );
    expect(results.filter((value) => value?.idempotent === false)).toHaveLength(
      1,
    );
    expect(results[0]).toMatchObject({
      amountMinor: 10000,
      voucherAmountMinor: 5000,
      cardAmountMinor: 5000,
    });
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(5000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(1);
    expect(await BookingPaymentRefund.countDocuments()).toBe(1);
    await mongoose.connection.transaction((session) =>
      refundBookingOriginalPaymentInSession({
        ...inputs(secondBooking),
        session,
      }),
    );
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(
      15000,
    );
    const refunds = await BookingPaymentRefund.find().lean();
    expect(refunds.reduce((sum, row) => sum + row.cardAmountMinor, 0)).toBe(
      15000,
    );
  });
  it("never refunds an order belonging to another tenant", async () => {
    await seedPaidOrder();
    await expect(
      mongoose.connection.transaction((session) =>
        refundBookingOriginalPaymentInSession({
          ...inputs(),
          tenantId: String(otherTenant),
          session,
        }),
      ),
    ).rejects.toThrow("Paid order not found");
    expect(await BookingPaymentRefund.countDocuments()).toBe(0);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(0);
  });
  it("keeps the original expiry and restores expired value without making the code usable", async () => {
    const coupon = await seedPaidOrder();
    const expired = new Date(Date.now() - 86400000);
    await Coupon.updateOne(
      { _id: coupon._id },
      { $set: { expiresAt: expired } },
    );
    await mongoose.connection.transaction((session) =>
      refundBookingOriginalPaymentInSession({ ...inputs(), session }),
    );
    expect(await Coupon.findById(coupon._id)).toMatchObject({
      remainingValueMinor: 5000,
      isActive: false,
      expiresAt: expired,
    });
  });
  it.each([{ refundReviewRequired: true }, { revokedAt: new Date() }])(
    "does not bypass voucher review or revocation: %j",
    async (fields) => {
      const coupon = await seedPaidOrder();
      await Coupon.updateOne({ _id: coupon._id }, { $set: fields });
      await expect(
        mongoose.connection.transaction((session) =>
          refundBookingOriginalPaymentInSession({ ...inputs(), session }),
        ),
      ).rejects.toThrow(/reconciliation|review/i);
      expect(await BookingPaymentRefund.countDocuments()).toBe(0);
      expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(0);
    },
  );
  it("persists the provider result and leaves completed jobs out of later sweeps", async () => {
    await seedPaidOrder();
    await mongoose.connection.transaction((session) =>
      refundBookingOriginalPaymentInSession({ ...inputs(), session }),
    );
    expect(await processBookingPaymentRefunds()).toEqual({ processed: 1 });
    expect(await BookingPaymentRefund.findOne()).toMatchObject({
      status: "succeeded",
      refundId: "re_saved",
      cardAmountMinor: 5000,
      firstProviderAttemptAt: expect.any(Date),
    });
    expect(await processBookingPaymentRefunds()).toEqual({ processed: 0 });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it("records a later bank failure after success without restoring vouchers or issuing a second refund", async () => {
    const coupon = await seedPaidOrder();
    await mongoose.connection.transaction((session) =>
      refundBookingOriginalPaymentInSession({ ...inputs(), session }),
    );
    await processBookingPaymentRefunds();
    const failedEvent: any = {
      id: "evt_late_failure",
      type: "refund.failed",
      account: "acct_original",
      livemode: false,
      data: {
        object: {
          id: "re_saved",
          object: "refund",
          status: "failed",
          amount: 5000,
          currency: "czk",
          payment_intent: "pi_original",
          metadata: {},
        },
      },
    };
    expect(await processBookingPaymentRefundEvent(failedEvent)).toBe(true);
    expect(await processBookingPaymentRefundEvent(failedEvent)).toBe(true);
    expect(await BookingPaymentRefund.findOne()).toMatchObject({
      status: "review_required",
      providerStatus: "failed",
      completedAt: null,
      failureEventId: failedEvent.id,
    });
    expect(await processBookingPaymentRefunds()).toEqual({ processed: 0 });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect((await Coupon.findById(coupon._id))?.remainingValueMinor).toBe(5000);
    expect(await VoucherLedger.countDocuments({ kind: "reverse" })).toBe(1);
  });

  it("keeps a webhook failure terminal when a stale successful create response arrives afterward", async () => {
    await seedPaidOrder();
    await mongoose.connection.transaction((session) =>
      refundBookingOriginalPaymentInSession({ ...inputs(), session }),
    );
    provider.create.mockImplementationOnce(async (params: any) => {
      const refund = {
        id: "re_saved",
        object: "refund",
        status: "failed",
        amount: params.amount,
        currency: "czk",
        payment_intent: "pi_original",
        metadata: params.metadata,
      };
      expect(
        await processBookingPaymentRefundEvent({
          id: "evt_response_race",
          type: "refund.failed",
          account: "acct_original",
          livemode: false,
          data: { object: refund },
        } as any),
      ).toBe(true);
      return { ...refund, status: "succeeded" };
    });
    await processBookingPaymentRefunds();
    expect(await BookingPaymentRefund.findOne()).toMatchObject({
      status: "review_required",
      providerStatus: "failed",
      completedAt: null,
      claimToken: "",
      failureEventId: "evt_response_race",
    });
    expect(await processBookingPaymentRefunds()).toEqual({ processed: 0 });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
});
