import mongoose from "mongoose";

import {
  AccessCode,
  AccessCodeAuditEvent,
  AccessCodePool,
} from "./access-code.model.js";
import { ACCESS_CODE_STATUS } from "./access-code.constants.js";
import type {
  ListAccessCodeAuditDto,
  ListAccessCodePoolsDto,
  ListAccessCodesDto,
} from "./access-code.validators.js";

type AllowedLocationIds = readonly string[] | null;

const objectId = (value: string | mongoose.Types.ObjectId) =>
  new mongoose.Types.ObjectId(String(value));

const locationQuery = (
  requestedLocationId: string | undefined,
  allowedLocationIds: AllowedLocationIds,
) => {
  if (requestedLocationId) {
    if (
      allowedLocationIds !== null &&
      !allowedLocationIds.some(
        (locationId) => String(locationId) === String(requestedLocationId),
      )
    ) {
      return { $in: [] };
    }
    return objectId(requestedLocationId);
  }
  if (allowedLocationIds === null) return undefined;
  return { $in: allowedLocationIds.map(objectId) };
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const accessCodeInventoryRepository = {
  listPools(
    tenantId: string,
    filters: ListAccessCodePoolsDto,
    allowedLocationIds: AllowedLocationIds,
  ) {
    const location = locationQuery(filters.locationId, allowedLocationIds);
    return AccessCodePool.find({
      tenant: objectId(tenantId),
      ...(location ? { location } : {}),
      ...(filters.status === "archived"
        ? { isActive: false }
        : filters.status === "active" || !filters.includeArchived
          ? { isActive: true }
          : {}),
    })
      .sort({ isActive: -1, name: 1, createdAt: 1 })
      .exec();
  },

  findPoolById(tenantId: string, poolId: string, includePrivate = false) {
    const query = AccessCodePool.findOne({
      _id: objectId(poolId),
      tenant: objectId(tenantId),
    });
    if (includePrivate) query.select("+normalizedName");
    return query.exec();
  },

  createPool(tenantId: string, input: Record<string, unknown>) {
    return AccessCodePool.create({ ...input, tenant: objectId(tenantId) });
  },

  updatePool(
    tenantId: string,
    poolId: string,
    patch: Record<string, unknown>,
  ) {
    return AccessCodePool.findOneAndUpdate(
      { _id: objectId(poolId), tenant: objectId(tenantId), isActive: true },
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    ).exec();
  },

  archivePool(tenantId: string, poolId: string, actorId: string, now: Date) {
    return AccessCodePool.findOneAndUpdate(
      { _id: objectId(poolId), tenant: objectId(tenantId), isActive: true },
      {
        $set: {
          isActive: false,
          archivedAt: now,
          updatedBy: objectId(actorId),
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  },

  async retirePoolCodes(
    tenantId: string,
    poolId: string,
    actorId: string,
    now: Date,
  ) {
    await AccessCode.updateMany(
      {
        tenant: objectId(tenantId),
        pool: objectId(poolId),
        status: { $ne: ACCESS_CODE_STATUS.RETIRED },
      },
      {
        $set: {
          status: ACCESS_CODE_STATUS.RETIRED,
          retiredAt: now,
          updatedBy: objectId(actorId),
          emergencyReserveKey: null,
        },
      },
    ).exec();
  },

  listCodes(
    tenantId: string,
    filters: ListAccessCodesDto,
    allowedLocationIds: AllowedLocationIds,
  ) {
    const page = Math.max(filters.page, 1);
    const limit = Math.min(Math.max(filters.limit, 1), 100);
    const location = locationQuery(filters.locationId, allowedLocationIds);
    const query = {
      tenant: objectId(tenantId),
      ...(location ? { location } : {}),
      ...(filters.poolId ? { pool: objectId(filters.poolId) } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status === "expired"
        ? {
            status: { $ne: ACCESS_CODE_STATUS.RETIRED },
            validUntil: { $ne: null, $lte: new Date() },
          }
        : filters.status
          ? { status: filters.status }
          : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.search
        ? {
            $or: [
              { label: { $regex: escapeRegex(filters.search), $options: "i" } },
              { notes: { $regex: escapeRegex(filters.search), $options: "i" } },
            ],
          }
        : {}),
    };
    return Promise.all([
      AccessCode.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      AccessCode.countDocuments(query).exec(),
    ]);
  },

  findCodeById(tenantId: string, codeId: string, includeSecret = false) {
    const query = AccessCode.findOne({
      _id: objectId(codeId),
      tenant: objectId(tenantId),
      pool: { $ne: null },
    });
    if (includeSecret) {
      query.select("+entryCode +codeFingerprint +emergencyReserveKey");
    }
    return query.exec();
  },

  findFingerprint(
    tenantId: string,
    poolId: string,
    codeFingerprint: string,
    excludeId?: string,
  ) {
    return AccessCode.exists({
      tenant: objectId(tenantId),
      pool: objectId(poolId),
      codeFingerprint,
      ...(excludeId ? { _id: { $ne: objectId(excludeId) } } : {}),
    }).exec();
  },

  findNonRetiredEmergency(
    tenantId: string,
    poolId: string,
    excludeId?: string,
  ) {
    return AccessCode.exists({
      tenant: objectId(tenantId),
      pool: objectId(poolId),
      type: "emergency_reserve",
      status: { $ne: ACCESS_CODE_STATUS.RETIRED },
      ...(excludeId ? { _id: { $ne: objectId(excludeId) } } : {}),
    }).exec();
  },

  createCode(tenantId: string, input: Record<string, unknown>) {
    return AccessCode.create({ ...input, tenant: objectId(tenantId) });
  },

  updateCode(
    tenantId: string,
    codeId: string,
    patch: Record<string, unknown>,
  ) {
    return AccessCode.findOneAndUpdate(
      { _id: objectId(codeId), tenant: objectId(tenantId) },
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    ).exec();
  },

  retireCode(tenantId: string, codeId: string, actorId: string, now: Date) {
    return AccessCode.findOneAndUpdate(
      { _id: objectId(codeId), tenant: objectId(tenantId) },
      {
        $set: {
          status: ACCESS_CODE_STATUS.RETIRED,
          retiredAt: now,
          updatedBy: objectId(actorId),
          emergencyReserveKey: null,
        },
      },
      { returnDocument: "after", runValidators: true },
    ).exec();
  },

  listPoolSummaryCodes(tenantId: string, poolIds: string[]) {
    if (!poolIds.length) return Promise.resolve([]);
    return AccessCode.find({
      tenant: objectId(tenantId),
      pool: { $in: poolIds.map(objectId) },
      status: { $ne: ACCESS_CODE_STATUS.RETIRED },
    })
      .select("pool type status validFrom validUntil verifiedAt")
      .lean()
      .exec();
  },

  createAuditEvent(input: Record<string, unknown>) {
    return AccessCodeAuditEvent.create(input);
  },

  listAuditEvents(
    tenantId: string,
    filters: ListAccessCodeAuditDto,
    allowedLocationIds: AllowedLocationIds,
  ) {
    const location = locationQuery(filters.locationId, allowedLocationIds);
    const query = {
      tenant: objectId(tenantId),
      ...(location ? { location } : {}),
      ...(filters.poolId ? { pool: objectId(filters.poolId) } : {}),
      ...(filters.accessCodeId
        ? { accessCode: objectId(filters.accessCodeId) }
        : {}),
      ...(filters.action ? { action: filters.action } : {}),
    };
    return Promise.all([
      AccessCodeAuditEvent.aggregate([
        { $match: query },
        { $sort: { createdAt: -1, _id: -1 } },
        { $skip: (filters.page - 1) * filters.limit },
        { $limit: filters.limit },
        {
          $lookup: {
            from: "users",
            let: { actorId: "$actor", auditTenantId: "$tenant" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$_id", "$$actorId"] },
                      { $eq: ["$tenant", "$$auditTenantId"] },
                    ],
                  },
                },
              },
              { $project: { firstname: 1, lastname: 1, email: 1 } },
            ],
            as: "actorIdentity",
          },
        },
        {
          $set: {
            actorIdentity: { $arrayElemAt: ["$actorIdentity", 0] },
          },
        },
      ])
        .exec(),
      AccessCodeAuditEvent.countDocuments(query).exec(),
    ]);
  },
};
