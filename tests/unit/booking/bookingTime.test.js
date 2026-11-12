import { describe, expect, it } from "vitest";
import { calculateBookingBlocks } from "../../../src/modules/booking/booking.utils.js";
import { convertTimeToNumber } from "../../../src/shared/time/time.utils.js";

describe("bookingTime", () => {
  it("converts HH:mm to decimal hours", () => {
    expect(convertTimeToNumber("09:30")).toBe(9.5);
    expect(Number.isNaN(convertTimeToNumber("bad"))).toBe(true);
  });

  it("calculates 30-minute booking blocks", () => {
    expect(calculateBookingBlocks(new Date("2026-06-30T09:00:00"), new Date("2026-06-30T10:30:00"))).toBe(3);
  });
});
