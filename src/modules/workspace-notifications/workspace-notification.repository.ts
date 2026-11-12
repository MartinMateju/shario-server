import mongoose from "mongoose";

import WorkspaceNotificationModel from "./workspace-notification.model.js";
import type {
  WorkspaceNotification,
  WorkspaceNotificationCreateRecord,
  WorkspaceNotificationListFilters,
  WorkspaceNotificationReadAllFilters,
  WorkspaceNotificationRepositoryOptions,
  WorkspaceNotificationVisibility,
} from "./workspace-notification.types.js";
import { WORKSPACE_NOTIFICATION_STATUS } from "./workspace-notification.constants.js";

type WorkspaceNotificationQuery = Record<string, unknown>;

const toObjectId = (value: string): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(value);

const locationVisibilityClause = (
  allowedLocationIds: readonly string[] | null,
): WorkspaceNotificationQuery | null => {
  if (allowedLocationIds === null) return null;
  if (allowedLocationIds.length === 0) return { location: null };

  return {
    $or: [
      { location: null },
      { location: { $in: allowedLocationIds.map(toObjectId) } },
    ],
  };
};

const permissionVisibilityClause = (
  permissions: WorkspaceNotificationVisibility["permissions"],
): WorkspaceNotificationQuery =>
  permissions.length
    ? {
        $or: [
          { requiredPermission: "" },
          { requiredPermission: { $in: [...permissions] } },
        ],
      }
    : { requiredPermission: "" };

export const buildWorkspaceNotificationVisibilityQuery = (
  visibility: WorkspaceNotificationVisibility,
): WorkspaceNotificationQuery => {
  const clauses: WorkspaceNotificationQuery[] = [
    permissionVisibilityClause(visibility.permissions),
  ];
  const locationClause = locationVisibilityClause(
    visibility.allowedLocationIds,
  );
  if (locationClause) clauses.push(locationClause);

  return {
    tenant: toObjectId(visibility.tenantId),
    recipient: toObjectId(visibility.recipientUserId),
    ...(clauses.length ? { $and: clauses } : {}),
  };
};

export const buildWorkspaceNotificationListQuery = (
  filters: WorkspaceNotificationListFilters,
): WorkspaceNotificationQuery => ({
  ...buildWorkspaceNotificationVisibilityQuery(filters),
  ...(filters.category ? { category: filters.category } : {}),
  ...(filters.locationId ? { location: toObjectId(filters.locationId) } : {}),
  ...(filters.status === WORKSPACE_NOTIFICATION_STATUS.UNREAD
    ? { readAt: null }
    : filters.status === WORKSPACE_NOTIFICATION_STATUS.READ
      ? { readAt: { $ne: null } }
      : {}),
});

const toStoredRecord = (record: WorkspaceNotificationCreateRecord) => ({
  tenant: toObjectId(record.tenantId),
  recipient: toObjectId(record.recipientUserId),
  location: record.locationId ? toObjectId(record.locationId) : null,
  actor: record.actorUserId ? toObjectId(record.actorUserId) : null,
  eventType: record.eventType,
  category: record.category,
  severity: record.severity,
  title: record.title,
  message: record.message,
  actionUrl: record.actionUrl ?? "",
  sourceType: record.sourceType,
  sourceId: record.sourceId,
  requiredPermission: (record.requiredPermission ??
    "") as WorkspaceNotification["requiredPermission"],
  deduplicationKey: record.deduplicationKey,
  groupKey: record.groupKey ?? "",
  occurredAt: record.occurredAt ?? new Date(),
  occurrenceCount: 1,
  readAt: null,
});

export const workspaceNotificationRepository = {
  async list(filters: WorkspaceNotificationListFilters) {
    const query = buildWorkspaceNotificationListQuery(filters);
    const [result] = await WorkspaceNotificationModel.aggregate<{
      notifications: Array<Record<string, any>>;
      totals: Array<{ total: number }>;
    }>([
      { $match: query },
      { $sort: { _id: -1 } },
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
              $cond: [
                { $eq: [{ $ifNull: ["$readAt", null] }, null] },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $set: {
          "notification.occurrenceCount": "$occurrenceCount",
          "notification.readAt": {
            $cond: [
              { $gt: ["$unreadCount", 0] },
              null,
              "$notification.readAt",
            ],
          },
        },
      },
      { $replaceWith: "$notification" },
      { $sort: { _id: -1 } },
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
    const notifications = await WorkspaceNotificationModel.populate(
      result?.notifications ?? [],
      { path: "location", select: "name" },
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

  async summarize(
    visibility: WorkspaceNotificationVisibility,
    locationId?: string,
  ) {
    const query: WorkspaceNotificationQuery = {
      ...buildWorkspaceNotificationVisibilityQuery(visibility),
      readAt: null,
      ...(locationId ? { location: toObjectId(locationId) } : {}),
    };
    return WorkspaceNotificationModel.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: query },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]).exec();
  },

  async markRead(
    visibility: WorkspaceNotificationVisibility,
    notificationId: string,
    readAt = new Date(),
  ) {
    const scopedIdQuery = {
      ...buildWorkspaceNotificationVisibilityQuery(visibility),
      _id: toObjectId(notificationId),
    };
    const target = await WorkspaceNotificationModel.findOne(scopedIdQuery)
      .select("groupKey")
      .lean()
      .exec();
    if (!target) return null;

    const groupKey = String(target.groupKey ?? "");
    await WorkspaceNotificationModel.updateMany(
      {
        ...buildWorkspaceNotificationVisibilityQuery(visibility),
        ...(groupKey
          ? { groupKey }
          : { _id: toObjectId(notificationId) }),
        readAt: null,
      },
      { $set: { readAt } },
    ).exec();

    return WorkspaceNotificationModel.findOne(scopedIdQuery)
      .populate({ path: "location", select: "name" })
      .lean()
      .exec();
  },

  async markAllRead(
    filters: WorkspaceNotificationReadAllFilters,
    readAt = new Date(),
  ) {
    const result = await WorkspaceNotificationModel.updateMany(
      {
        ...buildWorkspaceNotificationVisibilityQuery(filters),
        readAt: null,
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.locationId
          ? { location: toObjectId(filters.locationId) }
          : {}),
      },
      { $set: { readAt } },
    ).exec();

    return result.modifiedCount;
  },

  async upsertMany(
    records: readonly WorkspaceNotificationCreateRecord[],
    options: WorkspaceNotificationRepositoryOptions = {},
  ) {
    if (records.length === 0) return { createdCount: 0 };

    const result = await WorkspaceNotificationModel.bulkWrite(
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
