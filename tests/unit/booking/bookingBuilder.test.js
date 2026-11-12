import { describe, expect, it } from "vitest";
import { BookingBuilder } from "../../builders/BookingBuilder.js";
import { buildTenantFixture } from "../../fixtures/tenant.fixture.js";

describe("BookingBuilder", () => {
  it("builds a readable private Grohova workshop booking", () => {
    const tenant = buildTenantFixture();

    const booking = new BookingBuilder()
      .withTenant(tenant)
      .grohova()
      .private()
      .workshop()
      .confirmed()
      .withGuests(3)
      .at("2026-07-01T09:00:00.000Z", "2026-07-01T10:30:00.000Z")
      .build();

    expect(String(booking.tenant)).toBe(String(tenant._id));
    expect(booking.location).toBe("grohova");
    expect(booking.bookingType).toBe("private");
    expect(booking.tag).toBe("workshop");
    expect(booking.numberOfGuests).toBe(3);
    expect(booking.paymentStatus).toBe("CONFIRMED");
  });
});
