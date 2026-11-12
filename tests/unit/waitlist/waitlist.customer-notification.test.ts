import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entryFindOne: vi.fn(),
  bookingFindOne: vi.fn(),
  publish: vi.fn(),
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

vi.mock("@/modules/waitlist/waitlist.model.js", () => ({
  WaitlistEntryModel: { findOne: mocks.entryFindOne },
}));
vi.mock("@/modules/booking/booking.model.js", () => ({
  default: { findOne: mocks.bookingFindOne },
}));
vi.mock("@/modules/customer-notifications/index.js", () => ({
  publishCustomerWaitlistNotification: mocks.publish,
}));

import { publishWaitlistCustomerNotificationForEntry } from "@/modules/waitlist/waitlist.customer-notification.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const ENTRY_ID = "507f1f77bcf86cd799439012";
const CUSTOMER_ID = "507f1f77bcf86cd799439013";
const SESSION_ID = "507f1f77bcf86cd799439014";
const LOCATION_ID = "507f1f77bcf86cd799439015";
const OFFERED_AT = new Date("2026-08-13T09:00:00.000Z");

describe("waitlist customer notification audience bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publish.mockResolvedValue({ createdCount: 1 });
    mocks.bookingFindOne.mockReturnValue(query({ location: LOCATION_ID }));
  });

  it("resolves an authenticated entry in the same tenant and session", async () => {
    const session = { transaction: true } as never;
    const entryQuery = query({
      _id: ENTRY_ID,
      tenant: TENANT_ID,
      customer: CUSTOMER_ID,
      courseSession: SESSION_ID,
      source: "customer",
      offeredAt: OFFERED_AT,
    });
    mocks.entryFindOne.mockReturnValue(entryQuery);

    await publishWaitlistCustomerNotificationForEntry({
      tenantId: TENANT_ID,
      entryId: ENTRY_ID,
      type: "waitlist_offered",
      deduplicationKey: `waitlist:${ENTRY_ID}:offer:2`,
      session,
      occurredAt: OFFERED_AT,
    });

    expect(mocks.entryFindOne).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId(ENTRY_ID),
      tenant: new mongoose.Types.ObjectId(TENANT_ID),
      source: "customer",
      customer: { $type: "objectId" },
    });
    expect(entryQuery.session).toHaveBeenCalledWith(session);
    expect(mocks.publish).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      recipientUserId: CUSTOMER_ID,
      entryId: ENTRY_ID,
      locationId: LOCATION_ID,
      type: "offered",
      deduplicationKey: `waitlist:${ENTRY_ID}:offer:2`,
      session,
      occurredAt: OFFERED_AT,
    });
  });

  it("skips guest and verification outbox rows", async () => {
    mocks.entryFindOne.mockReturnValue(query(null));
    await publishWaitlistCustomerNotificationForEntry({
      tenantId: TENANT_ID,
      entryId: ENTRY_ID,
      type: "waitlist_joined",
      deduplicationKey: `waitlist:${ENTRY_ID}:joined`,
    });
    await publishWaitlistCustomerNotificationForEntry({
      tenantId: TENANT_ID,
      type: "waitlist_verify",
      deduplicationKey: "waitlist-verification:1:1",
    });

    expect(mocks.entryFindOne).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("rejects a supplied entry from another tenant or without customer source", async () => {
    await publishWaitlistCustomerNotificationForEntry({
      tenantId: TENANT_ID,
      entry: {
        _id: ENTRY_ID,
        tenant: new mongoose.Types.ObjectId(),
        customer: CUSTOMER_ID,
        source: "customer",
      },
      type: "waitlist_cancelled",
      deduplicationKey: `waitlist:${ENTRY_ID}:cancelled`,
    });
    await publishWaitlistCustomerNotificationForEntry({
      tenantId: TENANT_ID,
      entry: {
        _id: ENTRY_ID,
        tenant: TENANT_ID,
        customer: CUSTOMER_ID,
        source: "guest",
      },
      type: "waitlist_cancelled",
      deduplicationKey: `waitlist:${ENTRY_ID}:cancelled`,
    });

    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
