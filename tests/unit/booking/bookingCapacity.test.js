import { describe, expect, it } from "vitest";
import { checkOverlappingCapacity, getNumberOfOverlaps } from "../../../src/modules/booking/services/booking.capacity.service.js";

describe("booking.capacity.service", () => {
  it("counts half-open interval overlaps", () => {
    const target = { start: "2026-06-30T10:00:00", end: "2026-06-30T11:00:00", location: "grohova" };
    const bookings = [
      { start: "2026-06-30T09:00:00", end: "2026-06-30T10:00:00", status: "processed", paymentStatus: "CONFIRMED", tag: "workshop", location: "grohova" },
      { start: "2026-06-30T10:30:00", end: "2026-06-30T11:30:00", status: "processed", paymentStatus: "CONFIRMED", tag: "workshop", location: "grohova" },
    ];
    expect(getNumberOfOverlaps(target, bookings, "grohova")).toBe(1);
  });

  it("detects Vaclavska reservation capacity overflow", () => {
    const existingBookings = Array.from({ length: 8 }, (_, index) => ({
      _id: String(index),
      start: "2026-06-30T10:00:00",
      end: "2026-06-30T11:00:00",
      status: "processed",
      paymentStatus: "CONFIRMED",
      tag: "workshop",
      location: "vaclavska",
    }));

    const result = checkOverlappingCapacity(
      {
        start: "2026-06-30T10:30:00",
        end: "2026-06-30T11:30:00",
        location: "vaclavska",
      },
      existingBookings,
      8,
    );

    expect(result.exceeds).toBe(true);
    expect(result.maxParticipantsAtTime).toBe(9);
    expect(result.conflictingTime).toBeInstanceOf(Date);
  });
});
