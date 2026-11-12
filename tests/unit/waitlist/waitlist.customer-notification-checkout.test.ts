import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entryUpdateOne: vi.fn(),
  entryFindOne: vi.fn(),
  entryFindOneAndUpdate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  publishCustomerNotification: vi.fn(),
}));

const query = (value: unknown) => {
  const chain = {
    select: vi.fn(),
    session: vi.fn(),
    lean: vi.fn(),
    exec: vi.fn().mockResolvedValue(value),
  };
  chain.select.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
};

vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { updateOne: vi.fn() },
}));
vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEntryModel: {
    updateOne: mocks.entryUpdateOne,
    findOne: mocks.entryFindOne,
    findOneAndUpdate: mocks.entryFindOneAndUpdate,
  },
  WaitlistEmailOutboxModel: { updateOne: mocks.outboxUpdateOne },
}));
vi.mock("@/modules/waitlist/waitlist.customer-notification.service.js", () => ({
  publishWaitlistCustomerNotificationForEntry:
    mocks.publishCustomerNotification,
}));

import {
  confirmWaitlistOrderFromWebhook,
  markLateWaitlistPaymentRefunded,
} from "@/modules/waitlist/waitlist.checkout.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ORDER_ID = "507f1f77bcf86cd799439012";
const ENTRY_ID = "507f1f77bcf86cd799439013";
const CUSTOMER_ID = "507f1f77bcf86cd799439014";
const NOW = new Date("2026-08-13T10:00:00.000Z");

const customerEntry = (overrides: Record<string, unknown> = {}) => ({
  _id: ENTRY_ID,
  tenant: TENANT_ID,
  customer: CUSTOMER_ID,
  source: "customer",
  email: "customer@example.test",
  firstName: "Ada",
  lastName: "Lovelace",
  ...overrides,
});

describe("waitlist checkout customer notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mongoSession = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(mongoSession as never);
    mocks.publishCustomerNotification.mockResolvedValue({ createdCount: 1 });
    mocks.outboxUpdateOne.mockReturnValue(query({ upsertedCount: 1 }));
  });

  it("publishes confirmation with the webhook transaction session", async () => {
    const session = { transaction: true } as never;
    const entry = customerEntry();
    mocks.entryUpdateOne.mockReturnValue(query({ modifiedCount: 1 }));
    mocks.entryFindOne.mockReturnValue(query(entry));

    await expect(
      confirmWaitlistOrderFromWebhook({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        claimToken: "claim-1",
        now: NOW,
        session,
      }),
    ).resolves.toEqual({ modifiedCount: 1 });

    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      entry,
      type: "waitlist_confirmed",
      deduplicationKey: `waitlist:${ENTRY_ID}:confirmed`,
      session,
    });
  });

  it("creates one transaction when confirmation has no existing session", async () => {
    const entry = customerEntry({ confirmedAt: NOW, terminalAt: NOW });
    mocks.entryUpdateOne.mockReturnValue(query({ modifiedCount: 1 }));
    mocks.entryFindOne.mockReturnValue(query(entry));

    await expect(
      confirmWaitlistOrderFromWebhook({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        claimToken: "claim-transaction",
        now: NOW,
      }),
    ).resolves.toEqual({ modifiedCount: 1 });

    expect(mongoose.startSession).toHaveBeenCalledOnce();
    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        entry,
        type: "waitlist_confirmed",
        session: expect.objectContaining({
          withTransaction: expect.any(Function),
        }),
      }),
    );
  });

  it("publishes the refund before inserting its durable email intent", async () => {
    const entry = customerEntry();
    mocks.entryFindOneAndUpdate.mockReturnValue(query(entry));

    await markLateWaitlistPaymentRefunded({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      now: NOW,
      refundId: "re_waitlist",
      amountMinor: 50_000,
      currency: "czk",
    });

    expect(mocks.publishCustomerNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        entry,
        type: "waitlist_refunded",
        deduplicationKey: `waitlist:${ENTRY_ID}:refunded`,
        session: expect.anything(),
      }),
    );
    expect(
      mocks.publishCustomerNotification.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.outboxUpdateOne.mock.invocationCallOrder[0]);
  });
});
