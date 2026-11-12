import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import Claim from "@/modules/membership/membership-course-discount-claim.model.js";
import { Order } from "@/modules/order/order.model.js";
import { reservePersonalCourseDiscounts, unavailablePersonalCourseDiscounts, releaseCancelledPersonalCourseDiscounts } from "@/modules/checkout/services/checkout.membership-course.service.js";

const id = () => new mongoose.Types.ObjectId();
const tenant = id(), member = id(), booking = id();
let db: MongoMemoryReplSet;
const ids = { tenantId: String(tenant), userId: String(member), bookingIds: [String(booking)] };
const checkout = async (order = id(), fail = false) => mongoose.connection.transaction(async (session) => {
  await reservePersonalCourseDiscounts({ ...ids, orderId: String(order), session });
  await Order.collection.insertOne({ _id: order, tenant, createdBy: member, status: "pending_order", isPaid: false, courseBookings: [{ bookingId: booking, quantity: 3 }] } as any, { session });
  if (fail) throw new Error("payment preparation failed");
  return order;
});

describe("personal course membership discount claims", () => {
  beforeAll(async () => { db = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(db.getUri()); await Claim.init(); }, 60000);
  beforeEach(async () => { await Promise.all([Claim.deleteMany({}), Order.deleteMany({})]); });
  afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });
  it("allows only one simultaneous discounted checkout for the same member and event", async () => {
    const outcomes = await Promise.allSettled([checkout(), checkout()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await Claim.countDocuments()).toBe(1);
    expect(await Order.countDocuments()).toBe(1);
    expect(await unavailablePersonalCourseDiscounts(ids)).toEqual(new Set([String(booking)]));
  });
  it("rolls back a claim with the failed order rather than stranding the member discount", async () => {
    await expect(checkout(id(), true)).rejects.toThrow("payment preparation failed");
    expect(await Claim.countDocuments()).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
    await expect(checkout()).resolves.toBeDefined();
  });
  it("releases only terminal unpaid orders, never pending or paid purchases", async () => {
    const order = await checkout();
    await releaseCancelledPersonalCourseDiscounts(String(tenant), String(order));
    expect(await Claim.countDocuments()).toBe(1);
    await Order.collection.updateOne({ _id: order }, { $set: { status: "cancelled_order" } });
    await releaseCancelledPersonalCourseDiscounts(String(tenant), String(order));
    expect(await Claim.countDocuments()).toBe(0);
    const paid = await checkout();
    await Order.collection.updateOne({ _id: paid }, { $set: { status: "processed_order", isPaid: true } });
    await releaseCancelledPersonalCourseDiscounts(String(tenant), String(paid));
    expect(await Claim.countDocuments()).toBe(1);
    expect(await unavailablePersonalCourseDiscounts(ids)).toEqual(new Set([String(booking)]));
  });
});
