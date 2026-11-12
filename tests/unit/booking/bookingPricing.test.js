import { describe, expect, it } from "vitest";
import { calculateWorkshopRefundAmount } from "../../../src/modules/booking/services/booking.pricing.service.js";

describe("booking.pricing.service", () => {
  it("calculates a workshop refund from recorded hours and participants", () => {
    const result = calculateWorkshopRefundAmount({
      numberOfHours: 1,
      numberOfGuests: 2,
      bookingProduct: { price: 150 },
    });

    expect(result.participants).toBe(2);
    expect(result.refundAmount).toBe(300);
  });
});
