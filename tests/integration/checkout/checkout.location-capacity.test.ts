import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/modules/access-codes/access-code.repository.js", () => ({
  createAccessCodeNotificationRepository: () => ({
    hasDeliveredForBooking: async () => false,
    hasModificationLockForBooking: async () => false,
  }),
  accessCodeNotificationRepository: {},
  accessCodeRepository: {},
}));

import Booking from "@/modules/booking/booking.model.js";
import { rescheduleMyBooking } from "@/modules/booking/booking.customer.service.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";

let replica: MongoMemoryReplSet;
const tenant = new mongoose.Types.ObjectId();
const user = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();
const models = [Booking, Location, User, Product];

const bookingPayload = (cardPayment = false) => ({
  _id: new mongoose.Types.ObjectId(),
  location,
  createdBy: user,
  bookingProduct: product,
  author: { name: "Checkout customer", customId: "CAPACITY-1" },
  numberOfHours: 1,
  numberOfGuests: 1,
  start: new Date("2030-01-07T10:00:00.000Z"),
  end: new Date("2030-01-07T11:00:00.000Z"),
  status: cardPayment ? ("pending" as const) : ("processed" as const),
  paymentStatus: cardPayment
    ? ("PENDING_PAYMENT" as const)
    : ("CONFIRMED" as const),
  paymentExpiresAt: cardPayment ? new Date(Date.now() + 3_600_000) : null,
  tag: "open-studio" as const,
  bookingMode: "private" as const,
  bookingType: "private" as const,
  plannedActivity: "UNDEFINED" as const,
});

const revision = async () =>
  (await Location.collection.findOne({ _id: location }))?.booking
    .capacityRevision;

describe("Open Studio capacity transactions with MongoDB projections", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);

  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
    await User.collection.insertOne({
      _id: user,
      tenant,
      isAccessGranted: true,
      tenantRole: "customer",
      platformRole: "none",
    });
    await Location.collection.insertOne({
      _id: location,
      tenant,
      isActive: true,
      booking: {
        enabled: true,
        timezone: "UTC",
        globalCapacity: 2,
        capacityRevision: 0,
        activitySelectionMode: "HIDDEN",
        privateSessionBlocksAll: true,
        slotStepMinutes: 30,
        minBookingMinutes: 60,
        maxBookingMinutes: 360,
      },
      openingHours: {
        monday: { isOpen: true, openTime: "08:00", closeTime: "18:00" },
      },
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });

  it.each([
    ["pending card", true],
    ["confirmed credit", false],
  ] as const)(
    "creates a %s reservation while retaining its atomic capacity lock",
    async (_label, cardPayment) => {
      const payload = bookingPayload(cardPayment);
      const bookings = await checkoutRepository.createBookings({
        tenantId: tenant,
        payloads: [payload],
        atomicCapacity: true,
      });
      expect(bookings).toHaveLength(1);
      expect(await Booking.findById(payload._id).lean()).toMatchObject({
        paymentStatus: payload.paymentStatus,
        numberOfGuests: 1,
      });
      expect(await revision()).toBe(1);
    },
  );

  it("reserves an additional guest and updates the same location lock", async () => {
    const payload = bookingPayload();
    await Booking.create({ ...payload, tenant });
    const order = new mongoose.Types.ObjectId();
    await checkoutRepository.reserveGuestIncreaseCapacity({
      tenantId: tenant,
      userId: user,
      orderId: order,
      reservations: [
        { bookingId: payload._id, addGuests: 1, billingBlocks: 2 },
      ],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await Booking.findById(payload._id).lean()).toMatchObject({
      capacityReservations: [expect.objectContaining({ order, quantity: 1 })],
    });
    expect(await revision()).toBe(1);
  });

  it("serializes competing private reservations and rolls back the losing lock", async () => {
    const results = await Promise.allSettled(
      [true, false].map((cardPayment) =>
        checkoutRepository.createBookings({
          tenantId: tenant,
          payloads: [bookingPayload(cardPayment)],
          atomicCapacity: true,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(await Booking.countDocuments({ tenant })).toBe(1);
    expect(await revision()).toBe(1);
  });

  it("reserves a class seat through its update pipeline and rejects an over-capacity checkout", async () => {
    const payload = {
      ...bookingPayload(),
      tenant,
      tag: "class" as const,
      numberOfGuests: 0,
    };
    await Booking.create(payload);
    const order = new mongoose.Types.ObjectId();
    const reserve = (orderId: mongoose.Types.ObjectId) =>
      checkoutRepository.reserveCourseCapacity({
        tenantId: tenant,
        orderId,
        expiresAt: new Date(Date.now() + 3_600_000),
        reservations: [
          {
            bookingId: payload._id,
            productId: product,
            quantity: 1,
            capacity: 1,
          },
        ],
      });
    await reserve(order);
    await expect(reserve(new mongoose.Types.ObjectId())).rejects.toMatchObject({
      code: "CHECKOUT_COURSE_CAPACITY_EXCEEDED",
    });
    expect(await Booking.findById(payload._id).lean()).toMatchObject({
      capacityReservations: [expect.objectContaining({ order, quantity: 1 })],
    });
  });

  it("reads opening hours during rescheduling and rolls back an invalid move", async () => {
    const payload = bookingPayload();
    await Booking.create({ ...payload, tenant });
    await expect(
      rescheduleMyBooking({
        tenantId: String(tenant),
        userId: String(user),
        bookingId: String(payload._id),
        start: new Date("2030-01-07T22:00:00.000Z"),
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "CUSTOMER_BOOKING_RESCHEDULE_OUTSIDE_HOURS",
    });
    expect(await Booking.findById(payload._id).lean()).toMatchObject({
      start: payload.start,
      end: payload.end,
    });
    expect(await revision()).toBe(0);
  });

  it("loads tenant-scoped course capacity inside the atomic studio reservation", async () => {
    await Location.updateOne({ _id: location }, { $set: {
      "booking.globalCapacity": 14,
      "booking.groupBookingBlocksAll": false,
      "booking.allowPublicSoloOverlap": true,
      "booking.maxPublicSoloOverlaps": 2,
    } });
    await Product.collection.insertOne({ _id: product, tenant, maxNumberOfParticipants: 8 });
    await Booking.create({ ...bookingPayload(), tenant, tag: "course", numberOfGuests: 0 });
    const requested = { ...bookingPayload(), numberOfGuests: 6, bookingMode: "public", bookingType: "public" };
    const snapshot = await checkoutRepository.findCurrentBookings({ tenantId: tenant, locationIds: [location] });
    expect(snapshot[0]).toMatchObject({ tag: "course", maxNumberOfParticipants: 8 });
    await expect(checkoutRepository.createBookings({
      tenantId: tenant, payloads: [{ ...requested, numberOfGuests: 7 }], atomicCapacity: true,
    })).rejects.toMatchObject({ code: "LOCATION_CAPACITY_EXCEEDED" });
    expect(await revision()).toBe(0);
    await expect(checkoutRepository.createBookings({
      tenantId: tenant, payloads: [requested], atomicCapacity: true,
    })).resolves.toHaveLength(1);
    expect(await revision()).toBe(1);
  });

  it("fails closed when a course references a different tenant's product", async () => {
    await Location.updateOne({ _id: location }, { $set: { "booking.groupBookingBlocksAll": false } });
    await Product.collection.insertOne({ _id: product, tenant: new mongoose.Types.ObjectId(), maxNumberOfParticipants: 1 });
    await Booking.create({ ...bookingPayload(), tenant, tag: "course", numberOfGuests: 0 });
    await expect(checkoutRepository.createBookings({
      tenantId: tenant,
      payloads: [{ ...bookingPayload(), bookingMode: "public", bookingType: "public" }],
      atomicCapacity: true,
    })).rejects.toMatchObject({ code: "LOCATION_OVERLAP_NOT_ALLOWED" });
    expect(await revision()).toBe(0);
  });

  it("persists explicit equipment-free classes and still reserves their global places", async () => {
    await Location.updateOne({ _id: location }, { $set: {
      "booking.globalCapacity": 14,
      "booking.groupBookingBlocksAll": false,
      "booking.allowPublicSoloOverlap": true,
      "booking.maxPublicSoloOverlaps": 2,
      "booking.activitySelectionMode": "OPTIONAL",
      "booking.activityCapacities": [{ activity: "WORKSTATION", capacity: 6 }],
    } });
    await Product.collection.insertOne({ _id: product, tenant, maxNumberOfParticipants: 5 });
    const course = await Booking.create({
      ...bookingPayload(), tenant, tag: "course", numberOfGuests: 0, courseEquipmentRequired: false,
    });
    expect(course.courseEquipmentRequired).toBe(false);
    await expect(checkoutRepository.createBookings({
      tenantId: tenant,
      payloads: [{ ...bookingPayload(), bookingMode: "public", bookingType: "public", plannedActivity: "WORKSTATION", numberOfGuests: 6 }],
      atomicCapacity: true,
    })).resolves.toHaveLength(1);
  });
});
