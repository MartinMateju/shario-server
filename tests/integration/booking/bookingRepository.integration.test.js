import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";

import Booking from "../../../src/modules/booking/booking.model.js";
import { createBookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { clearTestDatabase, connectTestDatabase, disconnectTestDatabase } from "../../helpers/mongoMemory.js";

// This optional database-backed suite remains skipped in the default test run.
describe.skip("bookingRepository tenant isolation", () => {
  beforeAll(connectTestDatabase);
  beforeEach(clearTestDatabase);
  afterAll(disconnectTestDatabase);

  it("returns only bookings for the active tenant", async () => {
    const tenantA = new mongoose.Types.ObjectId();
    const tenantB = new mongoose.Types.ObjectId();

    await Booking.insertMany([
      {
        tenant: tenantA,
        start: new Date("2026-06-30T09:00:00.000Z"),
        end: new Date("2026-06-30T10:00:00.000Z"),
        status: "processed",
        paymentStatus: "CONFIRMED",
        tag: "workshop",
        location: "grohova",
      },
      {
        tenant: tenantB,
        start: new Date("2026-06-30T11:00:00.000Z"),
        end: new Date("2026-06-30T12:00:00.000Z"),
        status: "processed",
        paymentStatus: "CONFIRMED",
        tag: "workshop",
        location: "grohova",
      },
    ]);

    const repository = createBookingRepository({ tenantId: tenantA });
    const bookings = await repository.find({});

    expect(bookings).toHaveLength(1);
    expect(String(bookings[0].tenant)).toBe(String(tenantA));
  });
});
