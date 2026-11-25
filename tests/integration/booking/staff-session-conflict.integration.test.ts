import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import Booking from "@/modules/booking/booking.model.js";
import { insertCalendarSessionsWithConflictCheck } from "@/modules/booking/services/booking.session-insert.service.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";

const tenant = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const product = new mongoose.Types.ObjectId();

const at = (hour: number) => new Date(Date.UTC(2027, 2, 2, hour));
const session = (startHour: number, endHour: number, tag = "private-studio") => ({
  createdBy: new mongoose.Types.ObjectId(),
  createdAt: new Date(),
  start: at(startHour),
  end: at(endHour),
  bookingProduct: product,
  author: { name: "Staff", customId: "STAFF" },
  numberOfHours: endHour - startHour,
  status: "processed",
  paymentStatus: "CONFIRMED",
  tag,
  bookingType: "private",
  bookingMode: null,
  location,
});
const insert = (records: Array<Record<string, unknown>>) =>
  insertCalendarSessionsWithConflictCheck({
    tenantId: String(tenant),
    locationId: String(location),
    records,
  });

const sharedClass = () => ({
  ...session(10, 12, "class"),
  plannedActivity: "SHARED_TABLE",
});
const insertOpenStudio = () => checkoutRepository.createBookings({
  tenantId: String(tenant),
  atomicCapacity: true,
  payloads: [{
    ...session(10, 12, "open-studio"),
    bookingType: "public",
    bookingMode: "public",
    plannedActivity: "WORKSTATION",
    numberOfGuests: 6,
  }],
});
const configureSharedLocation = async (overrides: Record<string, unknown> = {}) => {
  await Location.collection.updateOne({ _id: location }, {
    $set: {
      "booking.globalCapacity": 14,
      "booking.allowPublicOverlap": false,
      "booking.maxConcurrentOpenStudioBookings": 1,
      "booking.groupBookingBlocksAll": false,
      "booking.activityCapacities": [
        { activity: "WORKSTATION", capacity: 6 },
        { activity: "SHARED_TABLE", capacity: 8 },
      ],
      ...overrides,
    },
  });
  await Product.collection.insertOne({ _id: product, tenant, maxNumberOfParticipants: 8 });
};

describe("staff-created sessions respect existing bookings", () => {
  let replica: MongoMemoryReplSet;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri(), { autoIndex: false });
    await Promise.all([Booking.createCollection(), Location.createCollection(), Product.createCollection()]);
  }, 120_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      Booking.deleteMany({}),
      Location.collection.deleteMany({}),
      Product.collection.deleteMany({}),
    ]);
    await Location.collection.insertOne({
      _id: location,
      tenant,
      name: "Main",
      isActive: true,
      booking: {
        enabled: true,
        timezone: "UTC",
        globalCapacity: 6,
        allowPublicOverlap: true,
        maxConcurrentOpenStudioBookings: 6,
        capacityRevision: 0,
      },
    });
  });

  it("creates a session in a free slot and bumps the location lock", async () => {
    const result = await insert([session(10, 12)]);

    expect(result).toHaveLength(1);
    expect(await Booking.countDocuments({ tenant })).toBe(1);
    const stored = await Location.collection.findOne({ _id: location });
    expect(stored?.booking.capacityRevision).toBe(1);
  });

  it("rejects a private block on top of a customer Open Studio booking", async () => {
    await Booking.collection.insertOne({
      tenant,
      location,
      start: at(10),
      end: at(12),
      status: "processed",
      paymentStatus: "CONFIRMED",
      tag: "open-studio",
      bookingType: "public",
      bookingMode: "public",
      numberOfGuests: 2,
    });

    await expect(insert([session(11, 13)])).rejects.toMatchObject({
      statusCode: 409,
      code: "BOOKING_SESSION_CONFLICT",
    });
    expect(await Booking.countDocuments({ tenant })).toBe(1);
  });

  it("rejects the whole batch when one date conflicts, and overlapping new sessions", async () => {
    await insert([session(10, 12)]);

    await expect(
      insert([session(14, 15), session(11, 13)]),
    ).rejects.toMatchObject({ code: "BOOKING_SESSION_CONFLICT" });
    await expect(
      insert([session(16, 18), session(17, 19)]),
    ).rejects.toMatchObject({ code: "BOOKING_SESSION_CONFLICT" });
    expect(await Booking.countDocuments({ tenant })).toBe(1);
  });

  it("allows back-to-back sessions", async () => {
    await insert([session(10, 12)]);
    await expect(insert([session(12, 14)])).resolves.toHaveLength(1);
  });

  it.each(["class-first", "open-studio-first"])("shares a class and one Open Studio booking in %s order", async (order) => {
    await configureSharedLocation();

    if (order === "class-first") {
      await insert([sharedClass()]);
      await insertOpenStudio();
    } else {
      await insertOpenStudio();
      await insert([sharedClass()]);
    }

    expect(await Booking.countDocuments({ tenant })).toBe(2);
    const stored = await Location.collection.findOne({ _id: location });
    expect(stored?.booking.capacityRevision).toBe(2);
  });

  it.each([
    { "booking.globalCapacity": 13 },
    { "booking.groupBookingBlocksAll": true },
    { "booking.activityCapacities": [
      { activity: "WORKSTATION", capacity: 6 },
      { activity: "SHARED_TABLE", capacity: 7 },
    ] },
  ])("rejects a class that violates sharing or capacity rules: %j", async (overrides) => {
    await configureSharedLocation(overrides);
    await insertOpenStudio();

    await expect(insert([sharedClass()])).rejects.toMatchObject({ code: "BOOKING_SESSION_CONFLICT" });

    expect(await Booking.countDocuments({ tenant })).toBe(1);
    const stored = await Location.collection.findOne({ _id: location });
    expect(stored?.booking.capacityRevision).toBe(1);
  });

  it("serializes competing class and Open Studio inserts before admitting too many people", async () => {
    await configureSharedLocation({ "booking.globalCapacity": 13 });

    const results = await Promise.allSettled([
      insert([sharedClass()]),
      insertOpenStudio(),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await Booking.countDocuments({ tenant })).toBe(1);
    const stored = await Location.collection.findOne({ _id: location });
    expect(stored?.booking.capacityRevision).toBe(1);
  });
});
