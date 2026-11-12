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

import { CustomOrder } from "@/modules/custom-orders/custom-order.model.js";
import {
  publishCustomOrderDeadlineReminder,
  runCustomOrderDeadlineReminders,
} from "@/modules/custom-orders/custom-order.reminders.js";
import TenantMembership from "@/modules/tenant-access/tenant-membership.model.js";
import WorkspaceNotification from "@/modules/workspace-notifications/workspace-notification.model.js";
import { workspaceNotificationRepository } from "@/modules/workspace-notifications/workspace-notification.repository.js";

const ids = Object.fromEntries(
  [
    "tenant",
    "otherTenant",
    "location",
    "otherLocation",
    "owner",
    "staff",
    "muted",
    "restricted",
    "outsider",
  ].map((key) => [key, new mongoose.Types.ObjectId()]),
);
// End of the 2 November deadline in Prague is 23:00 UTC, not UTC midnight.
const deadlineAt = new Date("2030-11-02T23:00:00.000Z");
const noon = new Date("2030-11-02T12:00:00.000Z");
const models: mongoose.Model<any>[] = [CustomOrder, TenantMembership, WorkspaceNotification];
const makeOrder = (overrides = {}) =>
  CustomOrder.create({
    tenant: ids.tenant,
    location: ids.location,
    reference: "Z-TEST-1",
    title: "Six blue cups",
    description: "Six stoneware cups with handles.",
    pieceCount: 6,
    materials: "Stoneware",
    startDate: "2030-10-01",
    deadline: "2030-11-02",
    timeZone: "Europe/Prague",
    deadlineAt,
    currency: "CZK",
    ...overrides,
  });

describe("custom order deadline inbox delivery", () => {
  let replica: MongoMemoryReplSet;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  beforeEach(async () => {
    await Promise.all(models.map((model) => model.deleteMany({})));
    await TenantMembership.create(
      [
        { user: ids.owner, role: "owner" as const, locationAccess: { mode: "all" as const } },
        {
          user: ids.staff,
          role: "staff" as const,
          locationAccess: { mode: "selected" as const, locationIds: [ids.location] },
        },
        {
          user: ids.muted,
          role: "admin" as const,
          preferences: { notifications: { inApp: false } },
        },
        {
          user: ids.restricted,
          role: "staff" as const,
          locationAccess: {
            mode: "selected" as const,
            locationIds: [ids.otherLocation],
          },
        },
        { user: ids.outsider, role: "owner" as const, tenant: ids.otherTenant },
      ].map((membership) => ({
        tenant: ids.tenant,
        createdBy: ids.owner,
        updatedBy: ids.owner,
        ...membership,
      })),
    );
  });

  it("publishes once to eligible staff with a detail link and preserves the visible edit revision/date", async () => {
    const order = await makeOrder();
    const results = await Promise.all([
      publishCustomOrderDeadlineReminder(String(order._id), noon),
      publishCustomOrderDeadlineReminder(String(order._id), noon),
    ]);
    expect(results.sort()).toEqual([false, true]);
    const records = await WorkspaceNotification.find({}).lean();
    expect(records).toHaveLength(2);
    expect(records.map((record) => String(record.recipient)).sort()).toEqual(
      [String(ids.owner), String(ids.staff)].sort(),
    );
    for (const record of records) {
      expect(record.eventType).toBe("custom_order.due_soon");
      expect(record.requiredPermission).toBe("orders.view");
      expect(String(record.location)).toBe(String(ids.location));
      expect(record.actionUrl).toBe(`/app/custom-orders/${order._id}`);
    }
    const after = await CustomOrder.findById(order._id).lean();
    expect(after?.revision).toBe(order.revision);
    expect(after?.updatedAt).toEqual(order.updatedAt);
    expect(after?.dueSoonReminderAt).toEqual(noon);
    expect((await runCustomOrderDeadlineReminders(noon)).checked).toBe(0);
  });

  it("becomes overdue at the local end of the deadline day and never sends the earlier reminder late", async () => {
    const order = await makeOrder();
    expect(
      await publishCustomOrderDeadlineReminder(
        String(order._id),
        new Date(deadlineAt.getTime() - 1),
      ),
    ).toBe(true);
    expect(
      await publishCustomOrderDeadlineReminder(String(order._id), deadlineAt),
    ).toBe(true);
    expect(
      await publishCustomOrderDeadlineReminder(
        String(order._id),
        new Date(deadlineAt.getTime() + 1),
      ),
    ).toBe(false);
    expect(
      await WorkspaceNotification.countDocuments({
        eventType: "custom_order.overdue",
      }),
    ).toBe(2);
    await makeOrder({ reference: "Z-TEST-2" });
    expect(await runCustomOrderDeadlineReminders(deadlineAt)).toMatchObject({
      checked: 1,
      published: 1,
      failed: 0,
    });
    expect(
      await WorkspaceNotification.countDocuments({
        eventType: "custom_order.due_soon",
      }),
    ).toBe(2);
  });

  it("skips closed and distant orders; a changed deadline cycle receives a fresh reminder", async () => {
    const closed = await makeOrder({
      reference: "Z-CLOSED",
      status: "closed",
      closeReason: "completed",
    });
    const future = await makeOrder({
      reference: "Z-FUTURE",
      deadlineAt: new Date("2030-12-01T23:00:00Z"),
    });
    expect(
      await publishCustomOrderDeadlineReminder(String(closed._id), noon),
    ).toBe(false);
    expect(
      await publishCustomOrderDeadlineReminder(String(future._id), noon),
    ).toBe(false);
    const order = await makeOrder();
    await publishCustomOrderDeadlineReminder(String(order._id), noon);
    await CustomOrder.updateOne(
      { _id: order._id },
      { $set: { reminderCycle: 1, dueSoonReminderAt: null } },
    );
    expect(
      await publishCustomOrderDeadlineReminder(String(order._id), noon),
    ).toBe(true);
    expect(
      await WorkspaceNotification.countDocuments({
        sourceId: String(order._id),
      }),
    ).toBe(4);
  });

  it("rolls back the marker on inbox failure and retries without duplicate notifications", async () => {
    const order = await makeOrder();
    const spy = vi
      .spyOn(workspaceNotificationRepository, "upsertMany")
      .mockRejectedValueOnce(new Error("Temporary database failure"));
    expect(await runCustomOrderDeadlineReminders(noon)).toMatchObject({
      checked: 1,
      published: 0,
      failed: 1,
    });
    expect(
      (await CustomOrder.findById(order._id).lean())?.dueSoonReminderAt,
    ).toBeNull();
    expect(await WorkspaceNotification.countDocuments()).toBe(0);
    spy.mockRestore();
    expect(await runCustomOrderDeadlineReminders(noon)).toMatchObject({
      checked: 1,
      published: 1,
      failed: 0,
    });
    expect(await WorkspaceNotification.countDocuments()).toBe(2);
  });
});
