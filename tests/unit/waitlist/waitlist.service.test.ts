import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindOne: vi.fn(),
  bookingUpdateOne: vi.fn(),
  productFindOne: vi.fn(),
  orderExists: vi.fn(),
  entryFindOne: vi.fn(),
  entryFindOneAndUpdate: vi.fn(),
  entryCreate: vi.fn(),
  entryUpdateOne: vi.fn(),
  sequenceFindOneAndUpdate: vi.fn(),
  verificationFindOne: vi.fn(),
  verificationFindOneAndUpdate: vi.fn(),
  emailUpdateOne: vi.fn(),
  auditCreate: vi.fn(),
  publishCustomerNotification: vi.fn(),
}));

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: {
    findOne: mocks.bookingFindOne,
    updateOne: mocks.bookingUpdateOne,
  },
}));

vi.mock("@/modules/product/product.model.js", () => ({
  default: { findOne: mocks.productFindOne },
}));

vi.mock("@/modules/order/order.model.js", () => ({
  Order: { exists: mocks.orderExists },
}));

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEntryModel: {
    findOne: mocks.entryFindOne,
    findOneAndUpdate: mocks.entryFindOneAndUpdate,
    create: mocks.entryCreate,
    updateOne: mocks.entryUpdateOne,
  },
  WaitlistSequenceModel: {
    findOneAndUpdate: mocks.sequenceFindOneAndUpdate,
  },
  WaitlistVerificationModel: {
    findOne: mocks.verificationFindOne,
    findOneAndUpdate: mocks.verificationFindOneAndUpdate,
  },
  WaitlistEmailOutboxModel: { updateOne: mocks.emailUpdateOne },
  WaitlistAuditModel: { create: mocks.auditCreate },
}));

vi.mock("@/modules/waitlist/waitlist.customer-notification.service.js", () => ({
  publishWaitlistCustomerNotificationForEntry:
    mocks.publishCustomerNotification,
}));

import {
  joinCustomerWaitlist,
  promoteWaitlistEntry,
  reconcileWaitlistAfterDirectCourseBooking,
  verifyGuestWaitlist,
} from "@/modules/waitlist/waitlist.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const SESSION_ID = "507f1f77bcf86cd799439012";
const PRODUCT_ID = "507f1f77bcf86cd799439013";
const CUSTOMER_ID = "507f1f77bcf86cd799439014";
const ENTRY_ID = "507f1f77bcf86cd799439015";
const SECOND_ENTRY_ID = "507f1f77bcf86cd799439016";
const ORDER_ID = "507f1f77bcf86cd799439017";
const NOW = new Date("2026-08-07T10:00:00.000Z");
const START = new Date("2026-08-09T10:00:00.000Z");

const query = (value: unknown, failure?: unknown) => {
  const resolution = failure ? Promise.reject(failure) : Promise.resolve(value);
  const q: any = {};
  for (const method of ["select", "sort", "session", "lean", "populate"]) {
    q[method] = vi.fn(() => q);
  }
  q.exec = vi.fn(() => resolution);
  q.then = (resolve: any, reject: any) => resolution.then(resolve, reject);
  return q;
};

const execResult = (value: unknown) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const sessionRecord = {
  _id: SESSION_ID,
  tenant: TENANT_ID,
  bookingProduct: PRODUCT_ID,
  location: "507f1f77bcf86cd799439099",
  start: START,
  end: new Date("2026-08-09T12:00:00.000Z"),
  numberOfGuests: 10,
  waitlistConfig: {
    enabled: true,
    autoPromote: true,
    offerWindowHours: 24,
    cutoffHours: 2,
  },
  capacityReservations: [],
  waitlistCapacityHolds: [],
};

const productRecord = {
  _id: PRODUCT_ID,
  name: "Wheel class",
  price: 500,
  currency: "CZK",
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  maxNumberOfParticipants: 10,
  isActive: true,
};

const waitingEntry = (id = ENTRY_ID, sequence = 1) => ({
  _id: id,
  tenant: TENANT_ID,
  courseSession: SESSION_ID,
  product: PRODUCT_ID,
  customer: CUSTOMER_ID,
  identityKey: "identity",
  email: "person@example.test",
  firstName: "Ada",
  lastName: "Lovelace",
  state: "waiting",
  isLive: true,
  sequence,
  joinedAt: NOW,
  sessionStartSnapshot: START,
  priceSnapshot: {
    amountMinor: 50_000,
    currency: "CZK",
    version: "price-v1",
    productId: PRODUCT_ID,
  },
  managementGeneration: 1,
  offerGeneration: 0,
  save: vi.fn().mockResolvedValue(undefined),
});

describe("waitlist join and FIFO service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);
    mocks.emailUpdateOne.mockReturnValue(execResult({ upsertedCount: 1 }));
    mocks.auditCreate.mockResolvedValue([]);
    mocks.publishCustomerNotification.mockResolvedValue({ createdCount: 1 });
  });

  it("returns an existing live entry idempotently before checking changing capacity", async () => {
    const existing = waitingEntry();
    mocks.entryFindOne.mockReturnValue(query(existing));
    const result = await joinCustomerWaitlist({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      customer: {
        customerId: CUSTOMER_ID,
        email: " PERSON@example.test ",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      now: NOW,
    });
    expect(result).toMatchObject({ created: false, entry: { id: ENTRY_ID } });
    expect(mocks.bookingFindOne).not.toHaveBeenCalled();
    expect(mocks.entryCreate).not.toHaveBeenCalled();
  });

  it("bridges a verified guest identity to the signed-in customer without adding a second FIFO row", async () => {
    const existing = { ...waitingEntry(), customer: null, source: "guest" };
    mocks.entryFindOne.mockReturnValue(query(existing));
    const result = await joinCustomerWaitlist({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      customer: {
        customerId: CUSTOMER_ID,
        email: "person@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      now: NOW,
    });
    expect(result.created).toBe(false);
    expect(String(existing.customer)).toBe(CUSTOMER_ID);
    expect(existing.source).toBe("customer");
    expect(existing.save).toHaveBeenCalledOnce();
    expect(mocks.entryCreate).not.toHaveBeenCalled();
  });

  it("recovers the unique-index winner when concurrent joins race", async () => {
    const duplicate: any = new Error("duplicate key");
    duplicate.code = 11000;
    mocks.entryFindOne
      .mockReturnValueOnce(query(null, duplicate))
      .mockReturnValueOnce(query(waitingEntry()));
    const result = await joinCustomerWaitlist({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      customer: {
        customerId: CUSTOMER_ID,
        email: "person@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
      },
      now: NOW,
    });
    expect(result).toMatchObject({ created: false, entry: { id: ENTRY_ID } });
  });

  it("serializes a new full-session join, assigns the next sequence, and freezes the price", async () => {
    const created = waitingEntry();
    mocks.entryFindOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(created));
    mocks.bookingFindOne.mockReturnValue(query(sessionRecord));
    mocks.productFindOne.mockReturnValue(query(productRecord));
    mocks.bookingUpdateOne
      .mockReturnValueOnce(execResult({ modifiedCount: 1 }))
      // Full capacity means the immediate best-effort promotion cannot hold a
      // seat; the entry remains first in FIFO.
      .mockReturnValueOnce(execResult({ modifiedCount: 0 }));
    mocks.orderExists.mockReturnValue(query(null));
    mocks.sequenceFindOneAndUpdate.mockReturnValue(query({ next: 1 }));
    mocks.entryCreate.mockResolvedValue([created]);

    const result = await joinCustomerWaitlist({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      customer: {
        customerId: CUSTOMER_ID,
        email: "person@example.test",
        firstName: "Ada",
        lastName: "Lovelace",
        locale: "cs",
      },
      now: NOW,
    });
    expect(result).toMatchObject({ created: true, entry: { id: ENTRY_ID } });
    expect(mocks.sequenceFindOneAndUpdate).toHaveBeenCalledOnce();
    const create = mocks.entryCreate.mock.calls[0][0][0];
    expect(create).toMatchObject({
      state: "waiting",
      isLive: true,
      sequence: 1,
      locale: "cs",
      sessionStartSnapshot: START,
      priceSnapshot: {
        amountMinor: 50_000,
        currency: "CZK",
        productId: PRODUCT_ID,
      },
    });
    expect(create.priceSnapshot.version).toHaveLength(64);
    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        entryId: ENTRY_ID,
        type: "waitlist_joined",
        deduplicationKey: `waitlist:${ENTRY_ID}:joined`,
        session: expect.anything(),
      }),
    );
    expect(
      mocks.publishCustomerNotification.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.emailUpdateOne.mock.invocationCallOrder[0]);
    const joinLock = mocks.bookingUpdateOne.mock.calls[0];
    expect(joinLock[0].$expr.$gte).toBeDefined();
    expect(joinLock[1]).toEqual({ $inc: { waitlistJoinRevision: 1 } });
  });

  it("replays a consumed guest verification into the same management link", async () => {
    const entry = waitingEntry();
    mocks.verificationFindOneAndUpdate.mockReturnValue(query(null));
    mocks.verificationFindOne.mockReturnValue(
      query({ _id: "507f1f77bcf86cd799439099", entry: ENTRY_ID }),
    );
    mocks.entryFindOne.mockReturnValue(query(entry));
    const result = await verifyGuestWaitlist({
      tenantId: TENANT_ID,
      token: "v".repeat(43),
      now: NOW,
    });
    expect(result).toMatchObject({
      created: false,
      entry: { id: ENTRY_ID },
    });
    expect(result.managementToken).toHaveLength(43);
    expect(mocks.entryCreate).not.toHaveBeenCalled();
  });

  it("enforces FIFO and records an explicit, reasoned override in the audit log", async () => {
    const head = waitingEntry(ENTRY_ID, 1);
    const second = waitingEntry(SECOND_ENTRY_ID, 2);
    const offered = {
      ...second,
      state: "offered",
      offerGeneration: 1,
      offeredAt: NOW,
      offerExpiresAt: new Date("2026-08-08T10:00:00.000Z"),
    };
    mocks.bookingFindOne.mockReturnValue(
      query({ ...sessionRecord, numberOfGuests: 9 }),
    );
    mocks.productFindOne.mockReturnValue(query(productRecord));
    mocks.entryFindOne
      .mockReturnValueOnce(query(head))
      .mockReturnValueOnce(query(head))
      .mockReturnValueOnce(query(second));

    await expect(
      promoteWaitlistEntry({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        entryId: SECOND_ENTRY_ID,
        actor: { actorUserId: CUSTOMER_ID },
        now: NOW,
      }),
    ).rejects.toThrow(/first in the waitlist/i);
    expect(mocks.bookingUpdateOne).not.toHaveBeenCalled();

    mocks.bookingUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));
    mocks.entryFindOneAndUpdate.mockReturnValue(execResult(offered));
    const result = await promoteWaitlistEntry({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      entryId: SECOND_ENTRY_ID,
      actor: {
        actorUserId: CUSTOMER_ID,
        overrideFifo: true,
        reason: "Accessibility accommodation",
      },
      now: NOW,
    });
    expect(result).toMatchObject({ id: SECOND_ENTRY_ID, state: "offered" });
    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        entryId: SECOND_ENTRY_ID,
        type: "waitlist_offered",
        deduplicationKey: `waitlist:${SECOND_ENTRY_ID}:offer:1`,
        session: expect.anything(),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    expect(mocks.auditCreate.mock.calls[0][0][0]).toMatchObject({
      action: "promoted",
      reason: "Accessibility accommodation",
      overrideFifo: true,
      before: { state: "waiting" },
      after: { state: "offered", offerGeneration: 1 },
    });
  });

  it("publishes a direct-booking waitlist confirmation in the same transaction", async () => {
    const entry = { ...waitingEntry(), source: "customer" };
    mocks.entryFindOne.mockReturnValue(query(entry));
    mocks.bookingUpdateOne.mockReturnValue(execResult({ modifiedCount: 1 }));

    await expect(
      reconcileWaitlistAfterDirectCourseBooking({
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
        now: NOW,
      }),
    ).resolves.toBe(true);

    expect(entry).toMatchObject({
      state: "confirmed",
      isLive: false,
      confirmedAt: NOW,
      terminalAt: NOW,
    });
    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      entry,
      type: "waitlist_confirmed",
      deduplicationKey: `waitlist:${ENTRY_ID}:confirmed`,
      session: expect.anything(),
      occurredAt: NOW,
    });
  });
});
