import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { publishWorkspaceNotification } from "@/modules/workspace-notifications/services/workspace-notification-publisher.service.js";
import { CustomOrder } from "./custom-order.model.js";

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 100;

export const customOrderReminderQuery = (now: Date) => ({
  status: "active" as const,
  $or: [
    { deadlineAt: { $lte: now }, overdueReminderAt: null },
    {
      deadlineAt: {
        $gt: now,
        $lte: new Date(now.getTime() + REMINDER_WINDOW_MS),
      },
      dueSoonReminderAt: null,
    },
  ],
});

/**
 * The order lock, recipient inbox records and reminder marker commit together.
 * A concurrent close or deadline edit forces the transaction to retry against
 * current state. No email, checkout or payment action is involved.
 */
export const publishCustomOrderDeadlineReminder = async (
  orderId: string,
  now = new Date(),
): Promise<boolean> => {
  const session = await mongoose.startSession();
  try {
    let published = false;
    await session.withTransaction(async () => {
      published = false;
      const order = await CustomOrder.findOne({
        _id: orderId,
        ...customOrderReminderQuery(now),
      })
        .session(session)
        .lean()
        .exec();
      if (!order) return;

      const overdue = order.deadlineAt.getTime() <= now.getTime();
      const marker = overdue ? "overdueReminderAt" : "dueSoonReminderAt";
      const locked = await CustomOrder.updateOne(
        {
          _id: order._id,
          tenant: order.tenant,
          status: "active",
          reminderCycle: order.reminderCycle,
          [marker]: null,
        },
        { $set: { [marker]: now } },
        { session, timestamps: false },
      ).exec();
      if (!locked.modifiedCount) return;

      const label = `${order.reference} · ${order.title}`;
      await publishWorkspaceNotification({
        tenantId: String(order.tenant),
        locationId: String(order.location),
        requiredPermission: WORKSPACE_PERMISSION.ORDERS_VIEW,
        eventType: overdue ? "custom_order.overdue" : "custom_order.due_soon",
        severity: "warning",
        title: overdue
          ? { en: "Custom order overdue", cs: "Zakázka po termínu" }
          : {
              en: "Custom order deadline approaching",
              cs: "Blíží se termín zakázky",
            },
        message: overdue
          ? {
              en: `${label} passed its deadline (${order.deadline}). Review its progress.`,
              cs: `${label} je po termínu (${order.deadline}). Zkontrolujte její průběh.`,
            }
          : {
              en: `${label} is due on ${order.deadline}. Review its progress.`,
              cs: `${label} má termín ${order.deadline}. Zkontrolujte její průběh.`,
            },
        actionUrl: `/app/custom-orders/${order._id}`,
        sourceType: "custom-order",
        sourceId: String(order._id),
        deduplicationKey: `custom-order:${order._id}:${order.reminderCycle}:${overdue ? "overdue" : "due-soon"}`,
        occurredAt: now,
        session,
      });
      published = true;
    });
    return published;
  } finally {
    await session.endSession();
  }
};

export const runCustomOrderDeadlineReminders = async (now = new Date()) => {
  const candidates = await CustomOrder.find(customOrderReminderQuery(now))
    .select("_id")
    .sort({ deadlineAt: 1, _id: 1 })
    .limit(SCAN_LIMIT)
    .lean()
    .exec();
  const result = {
    checked: candidates.length,
    published: 0,
    skipped: 0,
    failed: 0,
  };
  for (const candidate of candidates) {
    try {
      const published = await publishCustomOrderDeadlineReminder(
        String(candidate._id),
        now,
      );
      if (published) result.published += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      logger.error(
        { err: error, customOrderId: String(candidate._id) },
        "Custom order deadline reminder failed; it will retry on the next scan.",
      );
    }
  }
  return result;
};
