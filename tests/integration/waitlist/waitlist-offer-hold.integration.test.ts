import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { waitlistServiceInternals } from "@/modules/waitlist/waitlist.service.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const start = new Date("2027-03-01T10:00:00.000Z");
const now = new Date("2027-02-01T10:00:00.000Z");
const expiresAt = new Date("2027-02-01T22:00:00.000Z");

const hold = async (
  sessionId: mongoose.Types.ObjectId,
  capacity: number,
  entryId = new mongoose.Types.ObjectId(),
) => {
  const session = await mongoose.startSession();
  try {
    return await waitlistServiceInternals.appendOfferHold({
      tenantId: String(tenant),
      sessionProduct: {
        session: { _id: sessionId },
        product: { maxNumberOfParticipants: capacity },
        settings: {} as never,
      },
      entry: { _id: entryId, sessionStartSnapshot: start },
      offerGeneration: 1,
      expiresAt,
      now,
      session,
    });
  } finally {
    await session.endSession();
  }
};

describe("waitlist offer seat hold", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(clearTestDatabase);

  it("writes the hold with a pipeline update against real MongoDB", async () => {
    const sessionId = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({
      _id: sessionId,
      tenant,
      start,
      status: "confirmed",
      numberOfGuests: 1,
    });

    await expect(hold(sessionId, 2)).resolves.toBe(true);

    const stored = await Booking.collection.findOne({ _id: sessionId });
    expect(stored?.waitlistCapacityHolds).toHaveLength(1);
    expect(stored?.waitlistCapacityHolds[0].expiresAt).toEqual(expiresAt);
  });

  it("does not hold a seat when the session is already full", async () => {
    const sessionId = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({
      _id: sessionId,
      tenant,
      start,
      status: "confirmed",
      numberOfGuests: 2,
    });

    await expect(hold(sessionId, 2)).resolves.toBe(false);

    const stored = await Booking.collection.findOne({ _id: sessionId });
    expect(stored?.waitlistCapacityHolds ?? []).toHaveLength(0);
  });
});
