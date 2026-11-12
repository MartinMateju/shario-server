import mongoose from "mongoose";

import MembershipPlanModel from "./membership-plan.model.js";
import MembershipPlanVersionModel from "./membership-plan-version.model.js";
import UserMembershipModel from "./user-membership.model.js";
import { MEMBERSHIP_PLAN_STATUS, OPEN_MEMBERSHIP_STATUSES } from "./membership.constants.js";
import type { MembershipPlanListFilters, UserMembershipListFilters } from "./membership.types.js";
import { toObjectId } from "./membership.utils.js";

const populatePlanVersions = (query: any) => query
  .populate("currentPublishedVersion")
  .populate("currentDraftVersion");

const planFilter = (filters: MembershipPlanListFilters): any => ({
  tenant: toObjectId(filters.tenantId),
  ...(filters.status
    ? { status: filters.status }
    : !filters.includeInactive
      ? { status: { $ne: MEMBERSHIP_PLAN_STATUS.ARCHIVED } }
      : {}),
});

const userMembershipFilter = (filters: UserMembershipListFilters) => ({
  tenant: toObjectId(filters.tenantId),
  ...(filters.userId
    ? { user: filters.userIds && !filters.userIds.includes(filters.userId) ? { $in: [] } : toObjectId(filters.userId) }
    : filters.userIds
      ? { user: { $in: filters.userIds.map(toObjectId) } }
      : {}),
  ...(filters.planId ? { plan: toObjectId(filters.planId) } : {}),
  ...(filters.status ? { status: filters.status } : {}),
  ...(filters.allowedLocationIds !== null && filters.allowedLocationIds !== undefined
    ? {
        $or: [
          { selectedLocation: { $in: filters.allowedLocationIds.map(toObjectId) } },
          {
            // Compatibility for legacy selected-scope records that predate the
            // immutable purchased location. Never infer one for all-scope plans.
            selectedLocation: null,
            "planSnapshot.locationScope.type": { $in: ["selected", "shared_selected"] },
            "planSnapshot.locationScope.locationIds": {
              $not: { $elemMatch: { $nin: filters.allowedLocationIds.map(toObjectId) } },
            },
          },
        ],
      }
    : {}),
  ...(filters.allowedPlanIds !== null && filters.allowedPlanIds !== undefined
    ? {
        plan: filters.planId
          ? filters.allowedPlanIds.includes(filters.planId)
            ? toObjectId(filters.planId)
            : { $in: [] }
          : { $in: filters.allowedPlanIds.map(toObjectId) },
      }
    : {}),
});

export const membershipRepository = {
  async listPlansWithScope(filters: MembershipPlanListFilters) {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const pipeline: any[] = [
      { $match: planFilter(filters) },
      { $lookup: {
        from: MembershipPlanVersionModel.collection.name,
        localField: "currentPublishedVersion",
        foreignField: "_id",
        as: "publishedVersions",
      } },
      { $lookup: {
        from: MembershipPlanVersionModel.collection.name,
        localField: "currentDraftVersion",
        foreignField: "_id",
        as: "draftVersions",
      } },
      { $set: {
        currentPublishedVersion: { $arrayElemAt: ["$publishedVersions", 0] },
        currentDraftVersion: { $arrayElemAt: ["$draftVersions", 0] },
      } },
      { $set: {
        relevantVersion: { $ifNull: ["$currentDraftVersion", "$currentPublishedVersion"] },
      } },
      { $unset: ["publishedVersions", "draftVersions"] },
    ];

    if (filters.allowedLocationIds !== null && filters.allowedLocationIds !== undefined) {
      const allowed = filters.allowedLocationIds.map(toObjectId);
      pipeline.push({ $match: {
        "relevantVersion.locationScope.type": { $in: ["selected", "shared_selected"] },
        $expr: {
          $eq: [
            { $size: { $setDifference: ["$relevantVersion.locationScope.locationIds", allowed] } },
            0,
          ],
        },
      } });
    }
    if (filters.locationId) {
      pipeline.push({ $match: { $or: [
        { "relevantVersion.locationScope.type": "all" },
        { "relevantVersion.locationScope.locationIds": toObjectId(filters.locationId) },
      ] } });
    }
    pipeline.push({ $facet: {
      plans: [
        { $sort: { sortOrder: 1, createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ],
      count: [{ $count: "total" }],
    } });
    const [result] = await MembershipPlanModel.aggregate(pipeline).exec();
    return {
      plans: result?.plans ?? [],
      total: Number(result?.count?.[0]?.total ?? 0),
    };
  },

  listPlans(filters: MembershipPlanListFilters) {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    return populatePlanVersions(
      MembershipPlanModel.find(planFilter(filters))
        .sort({ sortOrder: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ).exec();
  },

  countPlans(filters: MembershipPlanListFilters) {
    return MembershipPlanModel.countDocuments(planFilter(filters)).exec();
  },

  findPlanByIdForTenant(tenantId: string, planId: string) {
    return populatePlanVersions(MembershipPlanModel.findOne({
      _id: toObjectId(planId),
      tenant: toObjectId(tenantId),
    })).exec();
  },

  findPlanVersion(tenantId: string, planId: string, versionId: string) {
    return MembershipPlanVersionModel.findOne({
      _id: toObjectId(versionId),
      tenant: toObjectId(tenantId),
      plan: toObjectId(planId),
    }).exec();
  },

  findPublishedPlanVersion(tenantId: string, planId: string, versionId?: string) {
    const query: Record<string, unknown> = {
      _id: versionId ? toObjectId(versionId) : undefined,
      tenant: toObjectId(tenantId),
      plan: toObjectId(planId),
      status: "published",
    };
    if (!versionId) delete query._id;
    return MembershipPlanVersionModel.findOne(query).exec();
  },

  findOpenUserMembership(tenantId: string, userId: string, options: { includeStripe?: boolean; session?: mongoose.ClientSession } = {}) {
    let query = UserMembershipModel.findOne({
      tenant: toObjectId(tenantId),
      user: toObjectId(userId),
      status: { $in: OPEN_MEMBERSHIP_STATUSES },
      isOpen: true,
    });
    if (options.includeStripe) query = query.select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.lastEventCreated +stripe.lastEventId");
    if (options.session) query = query.session(options.session);
    return query.exec();
  },

  findActiveUserMembership(tenantId: string, userId: string) {
    return UserMembershipModel.findOne({
      tenant: toObjectId(tenantId),
      user: toObjectId(userId),
      status: { $in: ["active", "past_due", "paused", "cancel_scheduled"] },
      isOpen: true,
    }).exec();
  },

  findUserMembershipById(tenantId: string, membershipId: string, includeStripe = false) {
    let query = UserMembershipModel.findOne({
      _id: toObjectId(membershipId),
      tenant: toObjectId(tenantId),
    });
    if (includeStripe) query = query.select("+stripe.connectedAccountId +stripe.customerId +stripe.subscriptionId +stripe.checkoutSessionId +stripe.checkoutIdempotencyKey +stripe.checkoutRequestHash +stripe.lastEventCreated +stripe.lastEventId");
    return query.exec();
  },

  listUserMemberships(filters: UserMembershipListFilters) {
    const page = Math.max(filters.page ?? 1, 1);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    return UserMembershipModel.find(userMembershipFilter(filters))
      .populate("user", "firstname lastname email customId memberNumber")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .exec();
  },

  countUserMemberships(filters: UserMembershipListFilters) {
    return UserMembershipModel.countDocuments(userMembershipFilter(filters)).exec();
  },

  async findLocationScopedPlanIds(tenantId: string, locationIds: readonly string[]) {
    const plans = await this.listPlansWithScope({
      tenantId,
      allowedLocationIds: locationIds,
      includeInactive: true,
      page: 1,
      limit: 100,
    });
    return plans.plans.map((plan: any) => String(plan._id));
  },
};

export default membershipRepository;

