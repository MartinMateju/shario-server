import { describe, expect, it } from "vitest";
import { validateOpenStudioAvailabilityOrThrow, validateGuestIncreaseAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";
import { buildOpenStudioBookingsToCreate } from "@/modules/checkout/services/checkout.cart.service.js";
import { getOpenStudioBookingMode } from "@/modules/checkout/checkout.utils.js";

const locationId = "507f1f77bcf86cd799439011";
const productId = "507f1f77bcf86cd799439012";
const userId = "507f1f77bcf86cd799439013";
const start = new Date(Date.now() + 86400000);
const end = new Date(start.getTime() + 3600000);
const locationById = new Map([[locationId, { _id: locationId, isActive: true,
  booking: { enabled: true, globalCapacity: 8, allowPublicOverlap: true,
    maxConcurrentOpenStudioBookings: 8, activityCapacities: [{ activity: "WORKSTATION", capacity: 3 }] } }]]);
const booking = (overrides: Record<string, unknown> = {}) => ({
  _id: "507f1f77bcf86cd799439014", createdBy: userId, location: locationId,
  start, end, numberOfGuests: 1, bookingMode: "public", bookingType: "public",
  customerChoiceBooking: true, publicCapacityLimit: 2, plannedActivity: "WORKSTATION",
  tag: "open-studio", status: "processed", paymentStatus: "CONFIRMED", ...overrides,
});
const validate = (requested = booking(), currentBookings: any[] = []) =>
  validateOpenStudioAvailabilityOrThrow({ openStudioBookings: [requested], currentBookings, locationById });
const product = { _id: productId, kind: "open-studio", type: "workshop", bookingMode: "customer-choice",
  maxNumberOfParticipants: 1, openStudioPolicy: { publicCapacityMode: "fixed", publicCapacityLimit: 2, privateBookingSurcharge: 175 } };

describe("customer-choice Open Studio capacity", () => {
  it("counts the originator, their party, and other reservations toward two total people", () => {
    expect(() => validate(booking(), [booking()])).not.toThrow();
    expect(() => validate(booking({ numberOfGuests: 2 }))).not.toThrow();
    expect(() => validate(booking({ numberOfGuests: 2 }), [booking()])).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
    expect(() => validate(booking({ numberOfGuests: 3 }))).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
  });

  it("protects an existing restricted session from another product with a larger limit", () => {
    expect(() => validate(booking({ publicCapacityLimit: null, numberOfGuests: 2 }), [booking()])).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
  });

  it("counts active pending checkouts and guest holds but ignores expired holds", () => {
    const pending = booking({ paymentStatus: "PENDING_PAYMENT", paymentExpiresAt: new Date(Date.now() + 60000), numberOfGuests: 2 });
    expect(() => validate(booking(), [pending])).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
    expect(() => validate(booking(), [{ ...pending, paymentExpiresAt: new Date(0) }])).not.toThrow();
    expect(() => validate(booking(), [booking({ capacityReservations: [{ quantity: 1, expiresAt: new Date(Date.now() + 60000) }] })])).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
    expect(() => validate(booking(), [booking({ capacityReservations: [{ quantity: 1, expiresAt: new Date(0) }] })])).not.toThrow();
  });

  it("uses peak concurrent attendees for a booking spanning adjacent sessions", () => {
    const middle = new Date(start.getTime() + 1800000);
    expect(() => validate(booking(), [booking({ end: middle }), booking({ start: middle })])).not.toThrow();
    expect(() => validate(booking(), [booking({ end: middle }), booking({ start: new Date(middle.getTime() - 1) })])).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
  });

  it("uses activity capacity for activity-based public sessions", () => {
    expect(() => validate(booking({ publicCapacityLimit: null, numberOfGuests: 3 }))).not.toThrow();
    expect(() => validate(booking({ publicCapacityLimit: null, numberOfGuests: 4 }))).toThrowError(expect.objectContaining({ code: "LOCATION_ACTIVITY_CAPACITY_EXCEEDED" }));
  });

  it("lets a private own-group occupy studio capacity and excludes other bookings", () => {
    const privateBooking = booking({ bookingMode: "private", numberOfGuests: 8, publicCapacityLimit: null });
    expect(() => validate(privateBooking)).not.toThrow();
    expect(() => validate({ ...privateBooking, numberOfGuests: 9 })).toThrowError(expect.objectContaining({ code: "LOCATION_CAPACITY_EXCEEDED" }));
    expect(() => validate(privateBooking, [booking()])).toThrowError(expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }));
    expect(() => validate(booking(), [privateBooking])).toThrowError(expect.objectContaining({ code: "LOCATION_OVERLAP_NOT_ALLOWED" }));
  });

  it("retains public limits when adding guests to an existing booking", () => {
    const target = booking();
    expect(() => validateGuestIncreaseAvailabilityOrThrow({
      guestIncreaseBookings: [{ bookingId: target._id, addGuests: 1, billingBlocks: 2 }],
      targets: [target], userId, currentBookings: [target, booking({ _id: "another" })], locationById,
    })).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_PUBLIC_CAPACITY_EXCEEDED" }));
  });

  it("requires an explicit choice and preserves fixed legacy modes", () => {
    expect(() => getOpenStudioBookingMode({ product } as any, product)).toThrowError(expect.objectContaining({ code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED" }));
    expect(getOpenStudioBookingMode({ bookingMode: "private" } as any, product)).toBe("private");
    expect(getOpenStudioBookingMode({ bookingMode: "public" } as any, { ...product, bookingMode: "private" })).toBe("private");
  });

  it("derives immutable policy snapshots from the stored product instead of the browser", () => {
    const create = (bookingMode: "private" | "public", numberOfGuests: number) => buildOpenStudioBookingsToCreate({
      cartItems: [{ product: { ...product, openStudioPolicy: { publicCapacityLimit: 100 } }, locationId,
        start, end, bookingMode, numberOfGuests, publicCapacityLimit: 100 }],
      productById: new Map([[productId, product]]), user: { _id: userId }, paymentMode: "credits",
    });
    expect(create("public", 2)[0]).toMatchObject({ bookingMode: "public", publicCapacityLimit: 2, customerChoiceBooking: true });
    expect(create("private", 8)[0]).toMatchObject({ bookingMode: "private", publicCapacityLimit: null, numberOfGuests: 8, customerChoiceBooking: true });
  });
});
