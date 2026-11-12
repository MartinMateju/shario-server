import { describe, expect, it } from "vitest";

import { getCustomerReservationState } from "@/modules/booking/booking.customer-reservation.js";
import { serializeCustomerBooking } from "@/modules/booking/booking.customer.service.js";

const now = new Date("2026-10-22T08:00:00Z");
const pending = {
  tag: "open-studio",
  status: "pending",
  paymentStatus: "PENDING_PAYMENT",
};

describe("customer reservation lifecycle", () => {
  it("expires an unpaid hold at its deadline, including missing deadlines", () => {
    for (const paymentExpiresAt of [
      undefined,
      null,
      now,
      new Date(now.getTime() - 1),
    ]) {
      expect(
        getCustomerReservationState({ ...pending, paymentExpiresAt }, { now }),
      ).toBe("expired");
    }
    expect(
      getCustomerReservationState(
        {
          ...pending,
          paymentExpiresAt: new Date(now.getTime() + 1),
        },
        { now },
      ),
    ).toBe("awaiting_payment");
  });

  it("preserves paid but unfulfilled payments as attention, never active capacity", () => {
    for (const paymentStatus of ["PENDING_PAYMENT", "EXPIRED", "FAILED"]) {
      const dto = serializeCustomerBooking(
        { ...pending, paymentStatus, paymentExpiresAt: now },
        undefined,
        false,
        false,
        false,
        { now, hasPaidOrder: true },
      );
      expect(dto).toMatchObject({
        paymentStatus,
        paymentExpiresAt: now,
        reservationState: "awaiting_confirmation",
        isActiveReservation: false,
      });
    }
  });

  it("gives cancellation and completion precedence over payment evidence", () => {
    for (const status of ["cancelled", "canceled", "completed"]) {
      expect(
        getCustomerReservationState(
          { ...pending, status },
          { now, hasPaidOrder: true },
        ),
      ).toBe(status.startsWith("cancel") ? "cancelled" : "completed");
    }
  });

  it("retains legacy and paid shared Class reservations without inferring completion from time", () => {
    expect(getCustomerReservationState({ tag: "workshop" }, { now })).toBe(
      "confirmed",
    );
    expect(
      getCustomerReservationState({ ...pending, tag: "class" }, { now }),
    ).toBe("confirmed");
    expect(
      serializeCustomerBooking(
        {
          ...pending,
          paymentStatus: "CONFIRMED",
          start: new Date("2026-10-20T08:00:00Z"),
          end: new Date("2026-10-20T09:00:00Z"),
        },
        undefined,
        false,
        false,
        false,
        { now },
      ),
    ).toMatchObject({
      reservationState: "confirmed",
      isActiveReservation: true,
    });
  });
});
