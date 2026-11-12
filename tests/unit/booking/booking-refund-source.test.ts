import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordEmail: vi.fn(),
  dispatchEmail: vi.fn(),
  findBooking: vi.fn(),
  saveBooking: vi.fn(),
  findCredit: vi.fn(),
  incrementCredits: vi.fn(),
  refund: vi.fn(),
  refunds: vi.fn(),
  lock: vi.fn(),
  cancelAccess: vi.fn(),
  membership: vi.fn(),
  findTenant: vi.fn(),
  lifecycleNotification: vi.fn(),
  creditNotification: vi.fn(),
  adminNotification: vi.fn(),
}));
vi.mock(
  "@/modules/booking/services/booking.customer-notification.service.js",
  () => ({
    recordBookingLifecycleEmailInSession: mocks.recordEmail,
    dispatchBookingLifecycleEmailSafely: mocks.dispatchEmail,
  }),
);
vi.mock("@/modules/booking/booking.repository.js", () => ({
  createBookingRepository: () => ({
    findDocumentById: mocks.findBooking,
    save: mocks.saveBooking,
  }),
}));
vi.mock("@/modules/money-credit/money-credit.repository.js", () => ({
  createMoneyCreditRepository: () => ({ findByUser: mocks.findCredit }),
}));
vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: { incrementMoneyCredits: mocks.incrementCredits },
}));
vi.mock("@/modules/access-codes/access-code.repository.js", () => ({
  createAccessCodeNotificationRepository: () => ({
    hasModificationLockForBooking: mocks.lock,
    markCancelled: mocks.cancelAccess,
  }),
}));
vi.mock(
  "@/modules/membership/services/membership-entitlement.service.js",
  () => ({ reverseMembershipRedemption: mocks.membership }),
);
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.findTenant },
}));
vi.mock(
  "@/modules/workspace-notifications/workspace-notification.business-events.js",
  () => ({ emitPaymentRefundedNotificationSafely: mocks.adminNotification }),
);
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerBookingLifecycleNotificationSafely:
    mocks.lifecycleNotification,
  publishCustomerRefundNotificationSafely: mocks.creditNotification,
}));
vi.mock("@/modules/booking/services/booking-payment-refund.service.js", () => ({
  hasVoucherPayment: (order: any) =>
    Boolean(
      order.voucherRedemptions?.length ||
      order.paymentAllocations?.some((row: any) => row.method === "voucher"),
    ),
  refundBookingOriginalPaymentInSession: mocks.refund,
  getBookingPaymentRefunds: mocks.refunds,
}));
import {
  cancelBookingWithRefund,
  resolveBookingRefundSnapshot,
} from "@/modules/booking/services/booking.refund.service.js";

const tenantId = "64b000000000000000000001";
const bookingId = "64b000000000000000000002";
const userId = "64b000000000000000000003";
const orderId = "64b000000000000000000004";
const actorId = "64b000000000000000000005";
const makeOrder = (overrides: any = {}) => ({
  _id: orderId,
  isPaid: true,
  currency: "CZK",
  workshopBookings: [bookingId],
  lineItems: [{ booking: bookingId, grossAmountMinor: 10000 }],
  paymentAllocations: [
    { method: "voucher", amountMinor: 6000 },
    { method: "stripe", amountMinor: 4000 },
  ],
  ...overrides,
});
const booking = (overrides: any = {}) => ({
  _id: bookingId,
  createdBy: userId,
  location: actorId,
  tag: "open-studio",
  status: "processed",
  start: new Date(Date.now() + 86400000),
  paymentStatus: "CONFIRMED",
  orders: [makeOrder()],
  bookingProduct: { _id: actorId, price: 999, currency: "CZK" },
  ...overrides,
});
const input = { tenantId, bookingId, userId, actorUserId: actorId };
const sourceRefund = {
  method: "original_payment",
  amountMinor: 10000,
  currency: "CZK",
  voucherAmountMinor: 6000,
  voucherQuantity: 0,
  cardAmountMinor: 4000,
  status: "pending",
};
const extensionOrder = (
  key = actorId,
  amountMinor = 2500,
  overrides: any = {},
) =>
  makeOrder({
    _id: key,
    bookingExtension: { bookingId, amountMinor },
    paidAmountMinor: 0,
    grossAmountMinor: amountMinor,
    lineItems: [{ booking: bookingId, grossAmountMinor: amountMinor }],
    paymentAllocations: [{ method: "credits", amountMinor }],
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  const session = {
    withTransaction: vi.fn(async (work: any) => work()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
  mocks.findBooking.mockResolvedValue(booking());
  mocks.lock.mockResolvedValue(false);
  mocks.findCredit.mockResolvedValue(null);
  mocks.refund.mockResolvedValue(sourceRefund);
  mocks.incrementCredits.mockResolvedValue({
    newBalance: 120,
    transactionId: "credit-transaction",
  });
  const q: any = {
    exec: vi.fn().mockResolvedValue({ settings: { currency: "CZK" } }),
  };
  for (const method of ["select", "session", "lean"]) q[method] = () => q;
  mocks.findTenant.mockReturnValue(q);
});

describe("Open Studio cancellation refund source", () => {
  it("adds each paid extension once to the original paid amount", () => {
    const extension = extensionOrder();
    const result = resolveBookingRefundSnapshot(
      booking({
        orders: [
          makeOrder({
            paymentAllocations: [{ method: "credits", amountMinor: 10000 }],
          }),
          extension,
          extension,
          extensionOrder("64b000000000000000000006", 5000),
          extensionOrder("64b000000000000000000007", 1000, { isPaid: false }),
        ],
      }),
      "CZK",
    );
    expect(result.refundAmount).toBe(175);
  });
  it("does not use an extended legacy duration twice after rescheduling", () => {
    const result = resolveBookingRefundSnapshot(
      booking({
        numberOfHours: 3,
        numberOfGuests: 1,
        extensionBaseDurationMinutes: 60,
        extensionBaseEnd: new Date("2020-01-01T12:00:00Z"),
        bookingProduct: { _id: actorId, price: 50, currency: "CZK" },
        orders: [extensionOrder()],
      }),
      "CZK",
    );
    expect(result.refundAmount).toBe(75); // original legacy hour + added payment
  });
  it("rejects ambiguous or mismatched extension payment snapshots", () => {
    for (const overrides of [
      { paidAmountMinor: 2000 },
      { grossAmountMinor: 3000 },
      {
        paymentAllocations: [
          { method: "credits", amountMinor: -500 },
          { method: "credits", amountMinor: 3000 },
        ],
      },
      { currency: "EUR" },
      { bookingExtension: { bookingId: actorId, amountMinor: 2500 } },
      { lineItems: [] },
    ]) {
      expect(() =>
        resolveBookingRefundSnapshot(
          booking({
            orders: [makeOrder(), extensionOrder(actorId, 2500, overrides)],
          }),
          "CZK",
        ),
      ).toThrow();
    }
  });
  it("includes a card-funded extension using its actual card-paid snapshot", () => {
    const result = resolveBookingRefundSnapshot(
      booking({
        orders: [
          makeOrder({
            paymentAllocations: [{ method: "credits", amountMinor: 10000 }],
          }),
          extensionOrder(actorId, 2500, {
            paidAmountMinor: 2500,
            paymentAllocations: [{ method: "stripe", amountMinor: 2500 }],
          }),
        ],
      }),
      "CZK",
    );
    expect(result.refundAmount).toBe(125);
  });
  it("refunds paid extensions alongside restoring the original membership allowance", async () => {
    mocks.findBooking.mockResolvedValue(
      booking({
        orders: [
          makeOrder({
            paymentAllocations: [
              { method: "membership_credit", amountMinor: 10000 },
            ],
            membershipRedemption: {
              membershipId: orderId,
              ledgerEntryId: actorId,
              quantity: 1,
            },
          }),
          extensionOrder(),
        ],
      }),
    );
    const result: any = await cancelBookingWithRefund(input);
    expect(result).toMatchObject({
      refundType: "membership_credit",
      membershipQuantity: 1,
      refundAmount: 25,
      extensionRefundAmount: 25,
    });
    expect(mocks.membership).toHaveBeenCalledOnce();
    expect(mocks.incrementCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 25,
        currency: "CZK",
        session: expect.anything(),
      }),
    );
    expect(mocks.recordEmail).toHaveBeenCalledWith(
      expect.objectContaining({ refundExtraCreditAmount: 25 }),
      expect.anything(),
    );
  });
  it("restores the original voucher/card source and credits the explicit extension", async () => {
    mocks.findBooking.mockResolvedValue(
      booking({ orders: [makeOrder(), extensionOrder()] }),
    );
    const result: any = await cancelBookingWithRefund(input);
    expect(result).toMatchObject({
      refundType: "original_payment",
      refundAmount: 125,
      extensionRefundAmount: 25,
    });
    expect(mocks.refund).toHaveBeenCalledOnce();
    expect(mocks.incrementCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25 }),
    );
    expect(mocks.creditNotification).toHaveBeenCalledWith(
      expect.objectContaining({ refundAmount: 25 }),
    );
  });
  it("returns voucher/card sources with the actual actor and avoids credit balance and credit-restored notifications", async () => {
    const result: any = await cancelBookingWithRefund(input);
    expect(result).toMatchObject({
      refundType: "original_payment",
      refundAmount: 100,
      refund: sourceRefund,
    });
    expect(mocks.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        orderId,
        bookingId,
        actorId,
        session: expect.anything(),
      }),
    );
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.creditNotification).not.toHaveBeenCalled();
    expect(mocks.adminNotification).not.toHaveBeenCalled();
    expect(mocks.lifecycleNotification).toHaveBeenCalledOnce();
  });
  it("returns a repeated cancellation's saved refund without restoring or refunding twice", async () => {
    mocks.findBooking.mockResolvedValue(booking({ status: "cancelled" }));
    mocks.refunds.mockResolvedValue([{ ...sourceRefund, status: "succeeded" }]);
    const result: any = await cancelBookingWithRefund(input);
    expect(result).toMatchObject({
      idempotent: true,
      refund: { status: "succeeded" },
    });
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.saveBooking).not.toHaveBeenCalled();
  });
  it("preserves legacy studio-credit refunds using the paid line amount", async () => {
    mocks.findBooking.mockResolvedValue(
      booking({
        orders: [
          makeOrder({
            paymentAllocations: [{ method: "credits", amountMinor: 10000 }],
          }),
        ],
      }),
    );
    const result: any = await cancelBookingWithRefund(input);
    expect(result.newCreditBalance).toBe(120);
    expect(mocks.incrementCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, currency: "CZK" }),
    );
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.creditNotification).toHaveBeenCalledOnce();
  });
  it("refuses missing booking associations and supplemental paid sources rather than crediting voucher money", async () => {
    for (const orders of [
      [makeOrder({ workshopBookings: [] })],
      [
        makeOrder(),
        makeOrder({
          _id: actorId,
          paymentAllocations: [{ method: "stripe", amountMinor: 1000 }],
        }),
      ],
    ]) {
      mocks.findBooking.mockResolvedValue(booking({ orders }));
      await expect(cancelBookingWithRefund(input)).rejects.toThrow(
        /source review/i,
      );
    }
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
  it("does not fall back to credit refund when voucher restoration fails", async () => {
    mocks.refund.mockRejectedValueOnce(
      new Error("Voucher refund review required"),
    );
    await expect(cancelBookingWithRefund(input)).rejects.toThrow(
      /review required/,
    );
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.lifecycleNotification).not.toHaveBeenCalled();
  });
});
