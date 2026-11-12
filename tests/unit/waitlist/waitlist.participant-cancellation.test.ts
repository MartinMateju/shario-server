import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindOne: vi.fn(),
  bookingUpdateOne: vi.fn(),
  orderFindOne: vi.fn(),
  incrementCredits: vi.fn(),
  auditCreate: vi.fn(),
  promote: vi.fn(),
  originalRefund: vi.fn(),
  savedRefund: vi.fn(),
  recordEmail: vi.fn(),
  dispatchEmail: vi.fn(),
}));

vi.mock(
  "@/modules/booking/services/booking.customer-notification.service.js",
  () => ({
    recordCourseParticipantCancellationEmailInSession: mocks.recordEmail,
    dispatchBookingLifecycleEmailSafely: mocks.dispatchEmail,
  }),
);

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    findOne: mocks.bookingFindOne,
    updateOne: mocks.bookingUpdateOne,
  },
}));

vi.mock("@/modules/order/order.model.js", () => ({
  Order: { findOne: mocks.orderFindOne },
}));

vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: { incrementMoneyCredits: mocks.incrementCredits },
}));

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistAuditModel: { create: mocks.auditCreate },
}));

vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: mocks.promote,
}));

vi.mock("@/modules/booking/booking-payment-refund.model.js", () => ({
  BookingPaymentRefund: { findOne: mocks.savedRefund },
}));
vi.mock(
  "@/modules/booking/services/booking-payment-refund.service.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/modules/booking/services/booking-payment-refund.service.js")
    >()),
    refundBookingOriginalPaymentInSession: mocks.originalRefund,
  }),
);

import { cancelPaidCourseParticipants } from "@/modules/booking/services/booking.course-participant-cancellation.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f1f77bcf86cd799439012";
const ORDER_ID = "507f1f77bcf86cd799439013";
const USER_ID = "507f1f77bcf86cd799439014";
const ADMIN_ID = "507f1f77bcf86cd799439015";
const NOW = new Date("2026-08-07T10:00:00.000Z");

const query = (value: unknown) => {
  const q: any = {};
  for (const method of ["select", "session", "lean"])
    q[method] = vi.fn(() => q);
  q.exec = vi.fn().mockResolvedValue(value);
  return q;
};
const execResult = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const course = () => ({
  _id: SESSION_ID,
  numberOfGuests: 2,
  start: new Date("2026-08-10T10:00:00.000Z"),
  participants: [
    { order: ORDER_ID, name: "Ada" },
    { order: ORDER_ID, name: "Grace" },
  ],
  orders: [ORDER_ID],
});

const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: ORDER_ID,
  createdBy: USER_ID,
  currency: "CZK",
  lineItems: [
    { booking: SESSION_ID, grossAmountMinor: 30_000 },
    { booking: SESSION_ID, grossAmountMinor: 20_000 },
  ],
  paymentAllocations: [{ method: "card", amountMinor: 50_000 }],
  courseBookings: [{ bookingId: SESSION_ID }],
  courseCancellations: [] as any[],
  save: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("paid Class participant cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    mocks.bookingFindOne.mockReturnValue(query(course()));
    mocks.bookingUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));
    mocks.incrementCredits.mockResolvedValue({ newBalance: 750 });
    mocks.auditCreate.mockResolvedValue([]);
    mocks.promote.mockResolvedValue({ id: "promoted" });
    mocks.recordEmail.mockResolvedValue({ _id: "notice" });
    mocks.dispatchEmail.mockResolvedValue(undefined);
  });

  it("removes all seats for the paid order, refunds its immutable line snapshot, audits, and promotes per seat", async () => {
    const order = paidOrder();
    mocks.orderFindOne.mockReturnValue(query(order));
    const result = await cancelPaidCourseParticipants({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      actorUserId: ADMIN_ID,
      reason: "Customer requested cancellation",
      now: NOW,
    });

    expect(mocks.bookingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: expect.anything(),
        tenant: expect.anything(),
        "participants.order": expect.anything(),
        numberOfGuests: { $gte: 2 },
      }),
      {
        $pull: {
          participants: { order: expect.anything() },
          orders: expect.anything(),
        },
        $inc: { numberOfGuests: -2, waitlistJoinRevision: 1 },
      },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(mocks.incrementCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        amount: 500,
        currency: "CZK",
        transaction: expect.objectContaining({
          type: "refund",
          idempotencyKey: `course-participant:${ORDER_ID}:${SESSION_ID}:refund`,
          reason: "Customer requested cancellation",
        }),
        session: expect.anything(),
      }),
    );
    expect(order.courseCancellations).toEqual([
      expect.objectContaining({
        quantity: 2,
        refundAmountMinor: 50_000,
        currency: "CZK",
        reason: "Customer requested cancellation",
        refundedAt: NOW,
      }),
    ]);
    expect(order.save).toHaveBeenCalledOnce();
    expect(mocks.recordEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        bookingId: SESSION_ID,
        orderId: ORDER_ID,
        refundAmount: 500,
        refundCurrency: "CZK",
        refundType: "money_credits",
      }),
      expect.anything(),
    );
    expect(mocks.dispatchEmail).toHaveBeenCalledWith({ _id: "notice" });
    expect(mocks.auditCreate.mock.calls[0][0][0]).toMatchObject({
      action: "participant_removed",
      reason: "Customer requested cancellation",
      before: { booked: 2 },
      after: {
        booked: 0,
        orderId: ORDER_ID,
        removedParticipants: 2,
        refundAmountMinor: 50_000,
      },
    });
    expect(mocks.promote).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      removedParticipants: 2,
      refund: {
        amount: 500,
        amountMinor: 50_000,
        currency: "CZK",
        method: "money_credits",
        newBalance: 750,
      },
      idempotent: false,
    });
  });

  it("replays an already recorded cancellation without a second mutation, refund, or promotion", async () => {
    const order = paidOrder({
      courseCancellations: [
        {
          bookingId: SESSION_ID,
          quantity: 2,
          refundAmountMinor: 50_000,
          currency: "CZK",
        },
      ],
    });
    mocks.orderFindOne.mockReturnValue(query(order));
    const result = await cancelPaidCourseParticipants({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      actorUserId: ADMIN_ID,
      reason: "Replay",
      now: NOW,
    });
    expect(result.idempotent).toBe(true);
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.recordEmail).not.toHaveBeenCalled();
    expect(mocks.dispatchEmail).toHaveBeenCalledWith(null);
  });

  it("fails closed for membership-credit refunds and missing immutable line snapshots", async () => {
    mocks.orderFindOne.mockReturnValueOnce(
      query(
        paidOrder({
          paymentAllocations: [
            { method: "membership_credit", amountMinor: 50_000 },
          ],
        }),
      ),
    );
    await expect(
      cancelPaidCourseParticipants({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        orderId: ORDER_ID,
        actorUserId: ADMIN_ID,
        reason: "Membership case",
        now: NOW,
      }),
    ).rejects.toThrow(/manual entitlement review/i);
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();

    mocks.orderFindOne.mockReturnValueOnce(query(paidOrder({ lineItems: [] })));
    await expect(
      cancelPaidCourseParticipants({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        orderId: ORDER_ID,
        actorUserId: ADMIN_ID,
        reason: "Missing snapshot",
        now: NOW,
      }),
    ).rejects.toThrow(/immutable Class line snapshot/i);
  });

  it("does not refund when the participant CAS detects a concurrent change", async () => {
    mocks.orderFindOne.mockReturnValue(query(paidOrder()));
    mocks.bookingUpdateOne.mockReturnValue(execResult({ modifiedCount: 0 }));
    await expect(
      cancelPaidCourseParticipants({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        orderId: ORDER_ID,
        actorUserId: ADMIN_ID,
        reason: "Concurrent cancellation",
        now: NOW,
      }),
    ).rejects.toThrow(/changed during cancellation/i);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("restores voucher funding and queues only the card portion without adding workspace credits", async () => {
    const order = paidOrder({
      paymentAllocations: [
        { method: "voucher", amountMinor: 30000 },
        { method: "stripe", amountMinor: 20000 },
      ],
    });
    mocks.orderFindOne.mockReturnValue(query(order));
    mocks.originalRefund.mockResolvedValueOnce({
      method: "original_payment",
      amountMinor: 50000,
      voucherAmountMinor: 30000,
      voucherQuantity: 0,
      cardAmountMinor: 20000,
      currency: "CZK",
      status: "pending",
    });
    const result = await cancelPaidCourseParticipants({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      actorUserId: ADMIN_ID,
      reason: "Customer requested cancellation",
      now: NOW,
    });
    expect(mocks.originalRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        bookingId: SESSION_ID,
        actorId: ADMIN_ID,
        session: expect.anything(),
      }),
    );
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(result.refund).toMatchObject({
      method: "original_payment",
      amount: 500,
      voucherAmountMinor: 30000,
      cardAmountMinor: 20000,
      status: "pending",
    });
    expect(mocks.recordEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        refundType: "original_payment",
        refundCardAmountMinor: 20000,
        refundVoucherAmountMinor: 30000,
      }),
      expect.anything(),
    );
    expect(order.save).toHaveBeenCalledOnce();
  });

  it("reports a replay's current durable refund outcome without issuing it again", async () => {
    mocks.orderFindOne.mockReturnValue(
      query(
        paidOrder({
          paymentAllocations: [{ method: "voucher", amountMinor: 50000 }],
          courseCancellations: [
            {
              bookingId: SESSION_ID,
              quantity: 2,
              refundAmountMinor: 50000,
              currency: "CZK",
            },
          ],
        }),
      ),
    );
    mocks.savedRefund.mockReturnValue(
      query({
        amountMinor: 50000,
        voucherAmountMinor: 50000,
        voucherQuantity: 0,
        cardAmountMinor: 0,
        currency: "CZK",
        status: "succeeded",
      }),
    );
    const result = await cancelPaidCourseParticipants({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      actorUserId: ADMIN_ID,
      reason: "Replay",
      now: NOW,
    });
    expect(result.refund).toMatchObject({
      method: "original_payment",
      status: "succeeded",
    });
    expect(mocks.originalRefund).not.toHaveBeenCalled();
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();
  });

  it("does not complete participant removal when voucher restoration requires review", async () => {
    const order = paidOrder({
      paymentAllocations: [{ method: "voucher", amountMinor: 50000 }],
    });
    mocks.orderFindOne.mockReturnValue(query(order));
    mocks.originalRefund.mockRejectedValueOnce(
      new Error("Voucher refund requires manual review"),
    );
    await expect(
      cancelPaidCourseParticipants({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        orderId: ORDER_ID,
        actorUserId: ADMIN_ID,
        reason: "Cancel",
        now: NOW,
      }),
    ).rejects.toThrow(/manual review/);
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });
});
