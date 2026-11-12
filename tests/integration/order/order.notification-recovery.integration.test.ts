import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyNotificationRecoveryPlan,
  notificationRecoveryWrite,
  planNotificationRecovery,
} from "@/modules/order/order.notification-recovery.js";

let mongo: MongoMemoryReplSet;
let connection: mongoose.Connection;
let number = 0;
const now = new Date("2026-10-19T12:00:00Z");
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = await mongoose
    .createConnection(mongo.getUri(), { autoIndex: false })
    .asPromise();
}, 120_000);
afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});

const fixture = async (count = 1) => {
  const orders = connection
    .getClient()
    .db(`confirmation-recovery-${++number}`)
    .collection("orders");
  const tenant = new mongoose.Types.ObjectId();
  const rows = Array.from({ length: count }, () => ({
    _id: new mongoose.Types.ObjectId(),
    tenant,
    isPaid: true,
    status: "processed_order",
    legacyOrder: false,
    paidAt: new Date("2026-10-10T10:00:00Z"),
    customer: { email: "buyer@example.test" },
    notificationLog: [
      {
        type: "order_confirm",
        status: "FAILED",
        attempt: 3,
        error: "connect ECONNREFUSED 127.0.0.1:1025",
        provider: "exhausted",
        sentAt: new Date("2026-10-10T11:00:00Z"),
        to: "buyer@example.test",
      },
    ],
  }));
  await orders.insertMany(rows);
  const plan = planNotificationRecovery({
    tenantId: String(tenant),
    selections: rows.map((row) => ({
      orderId: String(row._id),
      reason: "smtp-loopback-refused",
    })),
    orders: await orders.find({ tenant }).toArray(),
    now,
  });
  const apply = async () => {
    const session = connection.getClient().startSession();
    try {
      await applyNotificationRecoveryPlan({
        plan,
        approvalToken: plan.approvalToken,
        orders,
        session,
        now,
      });
    } finally {
      await session.endSession();
    }
  };
  return { orders, tenant, rows, plan, apply };
};

describe("atomic recovery approval", () => {
  it("applies once across concurrent runs and retains the original events exactly", async () => {
    const { apply, orders, rows } = await fixture();
    const results = await Promise.allSettled([apply(), apply()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await orders.findOne({ _id: rows[0]._id });
    expect(stored!.notificationLog).toEqual([]);
    expect(stored!.notificationRecovery.previousEvents).toEqual(
      rows[0].notificationLog,
    );
    expect(stored!.notificationRecovery.to).toBe("buyer@example.test");
    expect(stored!.paidAt).toEqual(rows[0].paidAt);
    await expect(apply()).rejects.toThrow(/changed after review/);
  });

  it("rolls the entire selected batch back when a later order changes", async () => {
    const { apply, orders, rows } = await fixture(2);
    await orders.updateOne(
      { _id: rows[1]._id },
      { $set: { "notificationLog.0.status": "SENT" } },
    );
    await expect(apply()).rejects.toThrow(/changed after review/);
    const first = await orders.findOne({ _id: rows[0]._id });
    expect(first!.notificationRecovery).toBeUndefined();
    expect(first!.notificationLog).toEqual(rows[0].notificationLog);
  });

  it.each(["lock", "recipient", "legacy", "unpaid", "unknown"])(
    "rejects a concurrent %s change",
    async (change) => {
      const { apply, orders, rows } = await fixture();
      const update = {
        lock: {
          "notificationLock.lockedUntil": new Date(now.getTime() + 60_000),
        },
        recipient: { "customer.email": "different@example.test" },
        legacy: { legacyOrder: true },
        unpaid: { isPaid: false },
        unknown: { "notificationLog.0.status": "AMBIGUOUS" },
      }[change];
      await orders.updateOne({ _id: rows[0]._id }, { $set: update! });
      await expect(apply()).rejects.toThrow(/changed after review/);
      expect(
        (await orders.findOne({ _id: rows[0]._id }))!.notificationRecovery,
      ).toBeUndefined();
    },
  );

  it("fences the tenant in the atomic write even when an ID is known", async () => {
    const { plan, orders, rows } = await fixture();
    const write = notificationRecoveryWrite(plan.operations[0], {
      tenantId: String(new mongoose.Types.ObjectId()),
      approvalToken: plan.approvalToken,
      now,
    });
    expect(
      (await orders.updateOne(write.filter, write.update)).modifiedCount,
    ).toBe(0);
    expect(
      (await orders.findOne({ _id: rows[0]._id }))!.notificationLog,
    ).toEqual(rows[0].notificationLog);
  });
});
