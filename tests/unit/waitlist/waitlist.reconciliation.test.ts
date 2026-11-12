import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entryFind: vi.fn(),
  entryFindOne: vi.fn(),
  entryUpdateOne: vi.fn(),
  entryAggregate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  bookingFind: vi.fn(),
  orderFindOne: vi.fn(),
  orderUpdateOne: vi.fn(),
  productFind: vi.fn(),
  releaseEntryCapacity: vi.fn(),
  enqueueEmail: vi.fn(),
  promote: vi.fn(),
  stripeRetrieve: vi.fn(),
  stripeExpire: vi.fn(),
  publishCustomerNotification: vi.fn(),
}));

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEntryModel: {
    find: mocks.entryFind,
    findOne: mocks.entryFindOne,
    updateOne: mocks.entryUpdateOne,
    aggregate: mocks.entryAggregate,
  },
  WaitlistEmailOutboxModel: {
    collection: { collectionName: "waitlist_email_outbox" },
    updateOne: mocks.outboxUpdateOne,
  },
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { find: mocks.bookingFind },
}));

vi.mock(
  "@/modules/customer-notifications/customer-notification.model.js",
  () => ({
    default: { collection: { collectionName: "customer_notifications" } },
  }),
);

vi.mock("@/modules/order/order.model.js", () => ({
  Order: {
    findOne: mocks.orderFindOne,
    updateOne: mocks.orderUpdateOne,
  },
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.productFind },
}));

vi.mock("@/modules/waitlist/waitlist.service.js", () => ({
  promoteWaitlistEntry: mocks.promote,
  waitlistServiceInternals: {
    releaseEntryCapacity: mocks.releaseEntryCapacity,
    enqueueEmail: mocks.enqueueEmail,
  },
}));

vi.mock("@/modules/waitlist/waitlist.customer-notification.service.js", () => ({
  publishWaitlistCustomerNotificationForEntry:
    mocks.publishCustomerNotification,
}));

vi.mock("@/modules/tenant-payments/tenant-payment.stripe.gateway.js", () => ({
  getConnectedAccountRequestOptions: (accountId: string) => ({
    stripeAccount: accountId,
  }),
  getTenantPaymentStripe: () => ({
    checkout: {
      sessions: {
        retrieve: mocks.stripeRetrieve,
        expire: mocks.stripeExpire,
      },
    },
  }),
}));

import {
  reconcileCourseWaitlists,
  reconcileWaitlistCapacityForProduct,
  waitlistReconciliationInternals,
} from "@/modules/waitlist/waitlist.reconciliation.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f1f77bcf86cd799439012";
const SECOND_SESSION_ID = "507f1f77bcf86cd799439013";
const PRODUCT_ID = "507f1f77bcf86cd799439014";
const ENTRY_ID = "507f1f77bcf86cd799439015";
const SECOND_ENTRY_ID = "507f1f77bcf86cd799439016";
const ORDER_ID = "507f1f77bcf86cd799439017";
const NOW = new Date("2026-08-07T10:00:00.000Z");

const query = (value: unknown) => {
  const q: any = {};
  for (const method of ["select", "sort", "limit", "lean", "session"]) {
    q[method] = vi.fn(() => q);
  }
  q.exec = vi.fn().mockResolvedValue(value);
  q.then = (resolve: any, reject: any) =>
    Promise.resolve(value).then(resolve, reject);
  return q;
};
const execResult = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const entryDocument = (overrides: Record<string, unknown> = {}) => ({
  _id: ENTRY_ID,
  tenant: TENANT_ID,
  courseSession: SESSION_ID,
  state: "offered",
  isLive: true,
  offerTokenHash: "hash",
  email: "person@example.test",
  firstName: "Ada",
  lastName: "Lovelace",
  checkout: undefined,
  save: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe("course waitlist reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    mocks.entryUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));
    mocks.outboxUpdateOne.mockReturnValue(execResult({ upsertedCount: 1 }));
    mocks.orderUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));
    mocks.releaseEntryCapacity.mockResolvedValue(undefined);
    mocks.enqueueEmail.mockResolvedValue(undefined);
    mocks.promote.mockResolvedValue(null);
    mocks.publishCustomerNotification.mockResolvedValue({ createdCount: 1 });
  });

  it("expires offered entries oldest-first, releases the hold, dedupes email, and promotes FIFO", async () => {
    const candidate = {
      _id: ENTRY_ID,
      tenant: TENANT_ID,
      courseSession: SESSION_ID,
    };
    const entry = entryDocument();
    mocks.entryFind.mockReturnValue(query([candidate]));
    mocks.entryFindOne.mockReturnValue(query(entry));

    await expect(
      waitlistReconciliationInternals.expireOfferedEntries(NOW),
    ).resolves.toBe(1);
    expect(mocks.releaseEntryCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, entry }),
    );
    expect(entry).toMatchObject({
      state: "expired",
      isLive: false,
      terminalAt: NOW,
      offerTokenHash: "",
      lastReconciledAt: NOW,
    });
    expect(mocks.enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "waitlist_expired",
        deduplicationKey: `waitlist:${ENTRY_ID}:expired`,
      }),
    );
    expect(mocks.promote).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      automatic: true,
      now: NOW,
    });
  });

  it("expires payment at the Stripe deadline only after Stripe is no longer payable", async () => {
    const candidate = {
      _id: ENTRY_ID,
      tenant: TENANT_ID,
      courseSession: SESSION_ID,
      checkout: {
        orderId: ORDER_ID,
        expiresAt: NOW,
        reservationExpiresAt: new Date("2026-08-08T10:00:00.000Z"),
      },
    };
    const entry = entryDocument({
      state: "payment_pending",
      checkout: candidate.checkout,
    });
    mocks.entryFind.mockReturnValue(query([candidate]));
    mocks.entryFindOne.mockReturnValue(query(entry));
    mocks.orderFindOne
      .mockReturnValueOnce(
        query({
          _id: ORDER_ID,
          isPaid: false,
          stripe: {
            sessionId: "cs_waitlist",
            connectedAccountId: "acct_studio",
          },
        }),
      )
      .mockReturnValueOnce(query({ _id: ORDER_ID, isPaid: false, stripe: {} }));
    mocks.stripeRetrieve.mockResolvedValue({
      status: "open",
      payment_status: "unpaid",
    });
    mocks.stripeExpire.mockResolvedValue({ status: "expired" });

    await expect(
      waitlistReconciliationInternals.expirePaymentPendingEntries(NOW),
    ).resolves.toBe(1);
    expect(mocks.stripeRetrieve).toHaveBeenCalledWith("cs_waitlist", {
      stripeAccount: "acct_studio",
    });
    expect(mocks.stripeExpire).toHaveBeenCalledWith("cs_waitlist", {
      stripeAccount: "acct_studio",
    });
    expect(mocks.releaseEntryCapacity).toHaveBeenCalledOnce();
    expect(mocks.orderUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ isPaid: false }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "cancelled_order" }),
      }),
      expect.anything(),
    );
    expect(entry.state).toBe("expired");
    expect(mocks.promote).toHaveBeenCalledOnce();
  });

  it("retains capacity on a Stripe read failure or a paid/complete session", async () => {
    const candidate = {
      _id: ENTRY_ID,
      tenant: TENANT_ID,
      courseSession: SESSION_ID,
      checkout: { orderId: ORDER_ID, expiresAt: NOW },
    };
    mocks.entryFind.mockReturnValue(query([candidate]));
    mocks.orderFindOne.mockReturnValue(
      query({
        _id: ORDER_ID,
        isPaid: false,
        stripe: {
          sessionId: "cs_waitlist",
          connectedAccountId: "acct_studio",
        },
      }),
    );
    mocks.stripeRetrieve.mockRejectedValueOnce(new Error("Stripe unavailable"));
    await expect(
      waitlistReconciliationInternals.expirePaymentPendingEntries(NOW),
    ).resolves.toBe(0);
    expect(mocks.releaseEntryCapacity).not.toHaveBeenCalled();

    mocks.stripeRetrieve.mockResolvedValueOnce({
      status: "complete",
      payment_status: "paid",
    });
    await expect(
      waitlistReconciliationInternals.expirePaymentPendingEntries(NOW),
    ).resolves.toBe(0);
    expect(mocks.releaseEntryCapacity).not.toHaveBeenCalled();
  });

  it("rotates reconciliation fairly past invalid heads and promotes later eligible sessions", async () => {
    mocks.entryAggregate.mockReturnValue(
      execResult([
        {
          _id: SESSION_ID,
          headEntryId: ENTRY_ID,
          lastReconciledAt: new Date("2026-08-01T00:00:00.000Z"),
        },
        {
          _id: SECOND_SESSION_ID,
          headEntryId: SECOND_ENTRY_ID,
          lastReconciledAt: new Date("2026-08-02T00:00:00.000Z"),
        },
      ]),
    );
    mocks.bookingFind.mockReturnValue(
      query([{ _id: SECOND_SESSION_ID, tenant: TENANT_ID }]),
    );
    mocks.promote
      .mockResolvedValueOnce({ id: SECOND_ENTRY_ID })
      .mockResolvedValueOnce(null);

    await expect(
      waitlistReconciliationInternals.promoteAvailableCapacity(NOW),
    ).resolves.toBe(1);
    expect(mocks.entryUpdateOne).toHaveBeenCalledWith(
      { _id: ENTRY_ID, state: "waiting" },
      { $set: { lastReconciledAt: NOW } },
    );
    expect(mocks.promote).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      sessionId: SECOND_SESSION_ID,
      automatic: true,
      now: NOW,
    });
    const aggregatePipeline = mocks.entryAggregate.mock.calls[0][0];
    expect(aggregatePipeline).toEqual(
      expect.arrayContaining([
        { $sort: { courseSession: 1, sequence: 1, _id: 1 } },
        { $sort: { lastReconciledAt: 1, _id: 1 } },
        { $limit: 100 },
      ]),
    );
  });

  it("materializes missing terminal email rows idempotently in terminal chronology", async () => {
    mocks.entryAggregate.mockReturnValue(
      execResult([
        {
          _id: ENTRY_ID,
          tenant: TENANT_ID,
          state: "withdrawn",
          email: "ada@example.test",
          firstName: "Ada",
          lastName: "Lovelace",
        },
      ]),
    );
    await expect(
      waitlistReconciliationInternals.ensureTerminalNotifications(),
    ).resolves.toBe(1);
    const pipeline = mocks.entryAggregate.mock.calls[0][0];
    expect(pipeline).toEqual(
      expect.arrayContaining([
        { $sort: { terminalAt: 1, _id: 1 } },
        { $limit: 100 },
      ]),
    );
    expect(pipeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $lookup: expect.objectContaining({
            from: "customer_notifications",
            as: "customerNotificationRows",
          }),
        }),
        expect.objectContaining({
          $match: expect.objectContaining({ $or: expect.any(Array) }),
        }),
      ]),
    );
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      { deduplicationKey: `waitlist:${ENTRY_ID}:withdrawn` },
      {
        $setOnInsert: expect.objectContaining({
          type: "waitlist_withdrawn",
          deduplicationKey: `waitlist:${ENTRY_ID}:withdrawn`,
          status: "pending",
        }),
      },
      { upsert: true },
    );
    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      entry: expect.objectContaining({ _id: ENTRY_ID, state: "withdrawn" }),
      type: "waitlist_withdrawn",
      deduplicationKey: `waitlist:${ENTRY_ID}:withdrawn`,
    });
    expect(
      mocks.publishCustomerNotification.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.outboxUpdateOne.mock.invocationCallOrder[0]);
  });

  it("backfills a confirmed customer notice without sending a second email", async () => {
    mocks.entryAggregate.mockReturnValue(
      execResult([
        {
          _id: ENTRY_ID,
          tenant: TENANT_ID,
          state: "confirmed",
          customer: "507f1f77bcf86cd799439099",
          source: "customer",
          confirmedAt: NOW,
          terminalAt: NOW,
        },
      ]),
    );

    await expect(
      waitlistReconciliationInternals.ensureTerminalNotifications(),
    ).resolves.toBe(1);

    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      entry: expect.objectContaining({
        _id: ENTRY_ID,
        state: "confirmed",
        confirmedAt: NOW,
      }),
      type: "waitlist_confirmed",
      deduplicationKey: `waitlist:${ENTRY_ID}:confirmed`,
    });
    expect(mocks.outboxUpdateOne).not.toHaveBeenCalled();
  });

  it("immediately reconciles all released seats after a product capacity increase", async () => {
    mocks.bookingFind.mockReturnValue(query([{ _id: SESSION_ID }]));
    mocks.promote
      .mockResolvedValueOnce({ id: ENTRY_ID })
      .mockResolvedValueOnce({ id: SECOND_ENTRY_ID })
      .mockResolvedValueOnce(null);
    await expect(
      reconcileWaitlistCapacityForProduct({
        tenantId: TENANT_ID,
        productId: PRODUCT_ID,
        now: NOW,
      }),
    ).resolves.toBe(2);
    expect(mocks.promote).toHaveBeenCalledTimes(3);
    expect(mocks.bookingFind.mock.calls[0][0]).toMatchObject({
      tenant: expect.anything(),
      bookingProduct: expect.anything(),
      "waitlistConfig.enabled": true,
      "waitlistConfig.autoPromote": true,
    });
  });

  it("runs every idempotent reconciliation phase in lifecycle order", async () => {
    // Empty model results let the real orchestration run without stubbing its
    // internals, guarding against a phase silently falling out of the cron.
    mocks.entryFind.mockReturnValue(query([]));
    mocks.entryAggregate.mockReturnValue(execResult([]));
    mocks.bookingFind.mockReturnValue(query([]));
    mocks.productFind.mockReturnValue(query([]));
    await expect(reconcileCourseWaitlists()).resolves.toEqual({
      synchronized: 0,
      offeredExpired: 0,
      paymentExpired: 0,
      lifecycleCancelled: 0,
      promoted: 0,
      notifications: 0,
    });
  });
});
