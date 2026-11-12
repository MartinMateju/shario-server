import mongoose from "mongoose";

import CustomerNotificationModel from "./customer-notification.model.js";
import { CUSTOMER_NOTIFICATION_STATUS } from "./customer-notification.constants.js";
import type {
  CustomerNotificationCreateRecord,
  CustomerNotificationListFilters,
  CustomerNotificationReadAllFilters,
  CustomerNotificationRepositoryOptions,
  CustomerNotificationVisibility,
} from "./customer-notification.types.js";

type CustomerNotificationQuery = Record<string, unknown>;

const toObjectId = (value: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

export const buildCustomerNotificationVisibilityQuery = (
  visibility: CustomerNotificationVisibility,
): CustomerNotificationQuery => ({
  tenant: toObjectId(visibility.tenantId),
  recipient: toObjectId(visibility.recipientUserId),
});

export const buildCustomerNotificationListQuery = (
  filters: CustomerNotificationListFilters,
): CustomerNotificationQuery => ({
  ...buildCustomerNotificationVisibilityQuery(filters),
  ...(filters.category ? { category: filters.category } : {}),
  ...(filters.status === CUSTOMER_NOTIFICATION_STATUS.UNREAD
    ? { readAt: null }
    : filters.status === CUSTOMER_NOTIFICATION_STATUS.READ
      ? { readAt: { $ne: null } }
      : {}),
});

const toStoredRecord = (record: CustomerNotificationCreateRecord) => ({
  tenant: toObjectId(record.tenantId),
  recipient: toObjectId(record.recipientUserId),
  location: record.locationId ? toObjectId(record.locationId) : null,
  eventType: record.eventType,
  category: record.category,
  severity: record.severity,
  title: record.title,
  message: record.message,
  actionUrl: record.actionUrl ?? "",
  sourceType: record.sourceType,
  sourceId: record.sourceId,
  deduplicationKey: record.deduplicationKey,
  groupKey: record.groupKey ?? "",
  occurredAt: record.occurredAt ?? new Date(),
  occurrenceCount: 1,
  readAt: null,
});

export const customerNotificationRepository = {
  async list(filters: CustomerNotificationListFilters) {
    const [result] = await CustomerNotificationModel.aggregate<{
      notifications: Array<Record<string, unknown>>;
      totals: Array<{ total: number }>;
    }>([
      { $match: buildCustomerNotificationListQuery(filters) },
      { $sort: { occurredAt: -1, _id: -1 } },
      {
        $group: {
          _id: {
            $cond: [
              { $ne: [{ $ifNull: ["$groupKey", ""] }, ""] },
              { $concat: ["group:", { $ifNull: ["$groupKey", ""] }] },
              { $concat: ["notification:", { $toString: "$_id" }] },
            ],
          },
          notification: { $first: "$$ROOT" },
          occurrenceCount: { $sum: 1 },
          unreadCount: {
            $sum: {
              $cond: [{ $eq: [{ $ifNull: ["$readAt", null] }, null] }, 1, 0],
            },
          },
        },
      },
      {
        $set: {
          "notification.occurrenceCount": "$occurrenceCount",
          "notification.readAt": {
            $cond: [{ $gt: ["$unreadCount", 0] }, null, "$notification.readAt"],
          },
        },
      },
      { $replaceWith: "$notification" },
      { $sort: { occurredAt: -1, _id: -1 } },
      {
        $facet: {
          notifications: [
            { $skip: (filters.page - 1) * filters.limit },
            { $limit: filters.limit },
          ],
          totals: [{ $count: "total" }],
        },
      },
    ]).exec();

    const notifications = await CustomerNotificationModel.populate(
      result?.notifications ?? [],
      { path: "location", select: "name slug" },
    );
    const total = Number(result?.totals?.[0]?.total ?? 0);

    return {
      notifications,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  },

  async summarize(visibility: CustomerNotificationVisibility) {
    return CustomerNotificationModel.aggregate<{
      _id: string;
      count: number;
    }>([
      {
        $match: {
          ...buildCustomerNotificationVisibilityQuery(visibility),
          readAt: null,
        },
      },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]).exec();
  },

  async markRead(
    visibility: CustomerNotificationVisibility,
    notificationId: string,
    readAt = new Date(),
  ) {
    const scopedIdQuery = {
      ...buildCustomerNotificationVisibilityQuery(visibility),
      _id: toObjectId(notificationId),
    };
    const target = await CustomerNotificationModel.findOne(scopedIdQuery)
      .select("groupKey")
      .lean()
      .exec();
    if (!target) return null;

    const groupKey = String(target.groupKey ?? "");
    await CustomerNotificationModel.updateMany(
      {
        ...buildCustomerNotificationVisibilityQuery(visibility),
        ...(groupKey ? { groupKey } : { _id: toObjectId(notificationId) }),
        readAt: null,
      },
      { $set: { readAt } },
    ).exec();

    return CustomerNotificationModel.findOne(scopedIdQuery)
      .populate({ path: "location", select: "name slug" })
      .lean()
      .exec();
  },

  async markAllRead(
    filters: CustomerNotificationReadAllFilters,
    readAt = new Date(),
  ) {
    const result = await CustomerNotificationModel.updateMany(
      {
        ...buildCustomerNotificationVisibilityQuery(filters),
        readAt: null,
        ...(filters.category ? { category: filters.category } : {}),
      },
      { $set: { readAt } },
    ).exec();

    return result.modifiedCount;
  },

  async upsertMany(
    records: readonly CustomerNotificationCreateRecord[],
    options: CustomerNotificationRepositoryOptions = {},
  ) {
    if (records.length === 0) return { createdCount: 0 };

    const result = await CustomerNotificationModel.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: {
            tenant: toObjectId(record.tenantId),
            recipient: toObjectId(record.recipientUserId),
            deduplicationKey: record.deduplicationKey,
          },
          update: { $setOnInsert: toStoredRecord(record) },
          upsert: true,
        },
      })),
      {
        ordered: false,
        ...(options.session ? { session: options.session } : {}),
      },
    );

    return { createdCount: result.upsertedCount };
  },
};
