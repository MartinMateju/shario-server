import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import { validateGuestIncreaseAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";

const makeContext = ({ holdExpiresAt }: { holdExpiresAt: Date }) => {
  const ownerId = new mongoose.Types.ObjectId();
  const bookingId = new mongoose.Types.ObjectId();
  const locationId = new mongoose.Types.ObjectId();
  const reservationOrderId = new mongoose.Types.ObjectId();
  const start = new Date(Date.now() + 2 * 60 * 60 * 1_000);
  const target = {
    _id: bookingId,
    createdBy: ownerId,
    location: locationId,
    start,
    end: new Date(start.getTime() + 60 * 60 * 1_000),
    status: "processed",
    paymentStatus: "CONFIRMED",
    numberOfGuests: 3,
    bookingType: "private",
    plannedActivity: "UNDEFINED",
    tag: "workshop",
    capacityReservations: [
      {
        order: reservationOrderId,
        quantity: 2,
        expiresAt: holdExpiresAt,
      },
    ],
  };

  return {
    ownerId,
    reservationOrderId,
    target,
    operation: { bookingId, addGuests: 1, billingBlocks: 2 },
    locationById: new Map([
      [
        String(locationId),
        {
          _id: locationId,
          isActive: true,
          booking: {
            enabled: true,
            globalCapacity: 4,
            privateSessionBlocksAll: false,
            groupBookingBlocksAll: false,
            allowPublicSoloOverlap: true,
            maxPublicSoloOverlaps: 4,
            activityCapacities: [],
          },
        },
      ],
    ]),
  };
};

describe("paid guest-increase capacity holds", () => {
  it("counts an active hold against location capacity", () => {
    const context = makeContext({
      holdExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: context.ownerId,
        currentBookings: [context.target],
        locationById: context.locationById,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
  });

  it("ignores an expired hold", () => {
    const context = makeContext({
      holdExpiresAt: new Date(Date.now() - 60_000),
    });

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: context.ownerId,
        currentBookings: [context.target],
        locationById: context.locationById,
      }),
    ).not.toThrow();
  });

  it("does not double-count the retrying checkout's own active hold", () => {
    const context = makeContext({
      holdExpiresAt: new Date(Date.now() + 60_000),
    });

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [context.operation],
        targets: [context.target],
        userId: context.ownerId,
        currentBookings: [context.target],
        locationById: context.locationById,
        reservationOrderId: context.reservationOrderId,
      }),
    ).not.toThrow();
  });

  it("validates overlapping target increases as one final capacity snapshot", () => {
    const ownerId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    const firstBookingId = new mongoose.Types.ObjectId();
    const secondBookingId = new mongoose.Types.ObjectId();
    const start = new Date(Date.now() + 2 * 60 * 60 * 1_000);
    const end = new Date(start.getTime() + 60 * 60 * 1_000);
    const makeTarget = (bookingId: mongoose.Types.ObjectId) => ({
      _id: bookingId,
      createdBy: ownerId,
      location: locationId,
      start,
      end,
      status: "processed",
      paymentStatus: "CONFIRMED",
      numberOfGuests: 1,
      bookingMode: "public",
      bookingType: "public",
      plannedActivity: "UNDEFINED",
      tag: "open-studio",
      capacityReservations: [],
    });
    const targets = [makeTarget(firstBookingId), makeTarget(secondBookingId)];

    expect(() =>
      validateGuestIncreaseAvailabilityOrThrow({
        guestIncreaseBookings: [
          { bookingId: firstBookingId, addGuests: 1, billingBlocks: 2 },
          { bookingId: secondBookingId, addGuests: 1, billingBlocks: 2 },
        ],
        targets,
        userId: ownerId,
        currentBookings: targets,
        locationById: new Map([
          [
            String(locationId),
            {
              _id: locationId,
              isActive: true,
              booking: {
                enabled: true,
                globalCapacity: 3,
                allowPublicOverlap: true,
                maxConcurrentOpenStudioBookings: 4,
                activityCapacities: [],
              },
            },
          ],
        ]),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }),
    );
  });
});
