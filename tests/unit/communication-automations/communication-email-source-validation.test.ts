import { describe, expect, it } from "vitest";

import { getCommunicationEmailSourceInvalidReason } from "@/modules/communication-automations/services/communication-email-source-validation.service.js";

const USER_ID = "507f191e810c19729de860ea";
const BOOKING_ID = "507f191e810c19729de860eb";
const baseLog = {
  user: USER_ID,
  relatedEntityId: BOOKING_ID,
  relatedEntityType: "booking",
  sourceScheduledAt: "2026-08-02T10:00:00.000Z",
};
const baseBooking = {
  _id: BOOKING_ID,
  status: "processed",
  paymentStatus: "CONFIRMED",
  start: "2026-08-02T10:00:00.000Z",
  end: "2026-08-02T12:00:00.000Z",
  orders: [{ createdBy: USER_ID, isPaid: true }],
};

describe("communication email source revalidation", () => {
  it("suppresses a queued course reminder after attendance removal but keeps the paid confirmation valid", () => {
    const paidAt = "2026-08-01T09:00:00.000Z";
    const entity = {
      ...baseBooking,
      tag: "class",
      attendanceManaged: true,
      participants: [{ order: "order-id", attendanceStatus: "removed" }],
      orders: [{ _id: "order-id", createdBy: USER_ID, isPaid: true, paidAt }],
    };
    const input = { entity, log: baseLog, recipientIsEligible: true, now: new Date("2026-08-01T10:00:00.000Z") };
    expect(getCommunicationEmailSourceInvalidReason({ ...input, automation: { scheduleType: "beforeBooking" } })).toBe("Recipient no longer has an active place in this course.");
    expect(getCommunicationEmailSourceInvalidReason({
      ...input,
      automation: { scheduleType: "afterBookingCreated" },
      log: { ...baseLog, sourceOrderId: "order-id", sourceScheduledAt: paidAt },
    })).toBeNull();
    expect(getCommunicationEmailSourceInvalidReason({
      ...input,
      automation: { scheduleType: "beforeBooking" },
      entity: { ...entity, participants: [...entity.participants, { order: "order-id", attendanceStatus: "active" }] },
    })).toBeNull();
  });
  const registration = {
    automation: {
      scheduleType: "afterRegistration",
      activatedAt: "2026-08-02T10:00:00.000Z",
    },
    log: {
      user: USER_ID,
      relatedEntityId: USER_ID,
      relatedEntityType: "user",
      scheduledFor: "2026-08-03T10:00:00.000Z",
    },
    entity: { _id: USER_ID, createdAt: "2026-08-02T10:00:00.000Z" },
    recipientIsEligible: true,
  };

  it("rejects a queued historical registration even when delivery was scheduled after activation", () => {
    expect(
      getCommunicationEmailSourceInvalidReason({
        ...registration,
        entity: {
          ...registration.entity,
          createdAt: "2026-08-02T09:59:59.999Z",
        },
      }),
    ).toBe("Customer registered before this automation was activated.");
  });

  it("rechecks the current activation when a queued welcome survives reactivation", () => {
    expect(getCommunicationEmailSourceInvalidReason(registration)).toBeNull();
    expect(
      getCommunicationEmailSourceInvalidReason({
        ...registration,
        automation: {
          ...registration.automation,
          activatedAt: "2026-08-02T10:01:00Z",
        },
      }),
    ).toBe("Customer registered before this automation was activated.");
  });

  it.each(["2026-08-02T10:00:00.000Z", "2026-08-02T10:00:00.001Z"])(
    "allows a registration at or after activation: %s",
    (createdAt) => {
      expect(
        getCommunicationEmailSourceInvalidReason({
          ...registration,
          entity: { ...registration.entity, createdAt },
        }),
      ).toBeNull();
    },
  );

  it.each([null, undefined, "not-a-date"])(
    "rejects missing or invalid activation and registration dates: %s",
    (invalidDate) => {
      for (const input of [
        {
          ...registration,
          automation: { ...registration.automation, activatedAt: invalidDate },
        },
        {
          ...registration,
          entity: { ...registration.entity, createdAt: invalidDate },
        },
      ]) {
        expect(getCommunicationEmailSourceInvalidReason(input)).toBe(
          "Registration activation or source date is missing or invalid.",
        );
      }
    },
  );

  it("does not allow registration logs without their customer source", () => {
    expect(
      getCommunicationEmailSourceInvalidReason({
        ...registration,
        log: { user: USER_ID },
      }),
    ).toBe("Registration source is missing.");
  });

  it.each(["beforeBooking", "afterBooking", "afterBookingCreated"])(
    "blocks an already queued %s delivery after migration suppression", (scheduleType) => {
      expect(getCommunicationEmailSourceInvalidReason({
        automation: { scheduleType },
        log: baseLog,
        entity: {
          ...baseBooking,
          atelierKleiMigration: { suppressHistoricalNotifications: true },
        },
        recipientIsEligible: true,
        now: new Date("2026-08-01T10:00:00.000Z"),
      })).toBe("Booking notifications are suppressed by its migration policy.");
    },
  );

  it("allows an imported booking whose notification suppression was explicitly released", () => {
    expect(getCommunicationEmailSourceInvalidReason({
      automation: { scheduleType: "beforeBooking" },
      log: baseLog,
      entity: {
        ...baseBooking,
        atelierKleiMigration: { suppressHistoricalNotifications: false },
      },
      recipientIsEligible: true,
      now: new Date("2026-08-01T10:00:00.000Z"),
    })).toBeNull();
  });

  it("cancels a refunded or removed booking purchaser", () => {
    expect(
      getCommunicationEmailSourceInvalidReason({
        automation: { scheduleType: "beforeBooking" },
        log: baseLog,
        entity: {
          ...baseBooking,
          orders: [{ createdBy: USER_ID, isPaid: false }],
        },
        recipientIsEligible: true,
        now: new Date("2026-08-01T10:00:00.000Z"),
      }),
    ).toBe("Recipient no longer owns a paid booking order.");
  });

  it("cancels a recovered before-booking reminder after the event starts", () => {
    expect(
      getCommunicationEmailSourceInvalidReason({
        automation: { scheduleType: "beforeBooking" },
        log: baseLog,
        entity: baseBooking,
        recipientIsEligible: true,
        now: new Date("2026-08-02T10:00:00.000Z"),
      }),
    ).toBe("Booking has already started.");
  });

  it("cancels deliveries to ineligible customers", () => {

    expect(
      getCommunicationEmailSourceInvalidReason({
        automation: { scheduleType: "afterRegistration" },
        log: {
          user: USER_ID,
          relatedEntityId: USER_ID,
          relatedEntityType: "user",
        },
        entity: { _id: USER_ID },
        recipientIsEligible: false,
      }),
    ).toBe("Recipient is no longer an eligible customer.");
  });

  it("allows a current paid purchaser before the booking starts", () => {
    expect(
      getCommunicationEmailSourceInvalidReason({
        automation: { scheduleType: "beforeBooking" },
        log: baseLog,
        entity: baseBooking,
        recipientIsEligible: true,
        now: new Date("2026-08-01T10:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("keeps a confirmation valid after rescheduling but cancels unpaid or canceled bookings", () => {
    const sourceOrderId = "507f191e810c19729de860ed";
    const paidAt = "2026-08-01T09:00:00.000Z";
    const input = {
      automation: { scheduleType: "afterBookingCreated" },
      log: { ...baseLog, sourceScheduledAt: paidAt, sourceOrderId },
      entity: {
        ...baseBooking,
        orders: [{ _id: sourceOrderId, createdBy: USER_ID, isPaid: true, paidAt }],
        start: "2026-09-02T10:00:00.000Z",
        end: "2026-09-02T12:00:00.000Z",
      },
      recipientIsEligible: true,
    };
    expect(getCommunicationEmailSourceInvalidReason(input)).toBeNull();
    expect(getCommunicationEmailSourceInvalidReason({
      ...input, entity: { ...input.entity, paymentStatus: "PENDING_PAYMENT" },
    })).toBe("Booking payment is no longer confirmed.");
    expect(getCommunicationEmailSourceInvalidReason({
      ...input, entity: { ...input.entity, status: "cancelled" },
    })).toBe("Booking was cancelled.");
    expect(getCommunicationEmailSourceInvalidReason({
      ...input, entity: { ...input.entity, orders: [
        { ...input.entity.orders[0], isPaid: false },
        { _id: "507f191e810c19729de860ee", createdBy: USER_ID, isPaid: true, paidAt },
      ] },
    })).toBe("Recipient no longer owns the confirmed booking order.");
  });
});
