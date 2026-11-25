import type { PipelineStage } from "mongoose";
import UserMembership from "@/modules/membership/user-membership.model.js";
import {
  membershipReportingDates,
  membershipReportingActive,
  membershipReportingUnknown,
} from "@/modules/membership/membership-reporting.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import {
  canReadCustomerMemberships,
  customerMembershipScope,
} from "./services/user.membership-summary.service.js";
import { customerDirectoryScope } from "./user.directory-query.js";
import User from "./user.model.js";

export const resolveDirectoryMembership = async (context: {
  tenantId: string;
  access: ResolvedWorkspaceAccess;
  now?: Date;
}) => ({
  tenantId: context.tenantId,
  canRead: await canReadCustomerMemberships(context),
  scope: customerMembershipScope(context),
  now: context.now ?? new Date(),
});
export type DirectoryMembership = Awaited<
  ReturnType<typeof resolveDirectoryMembership>
>;

/** Normally placed after the page limit. Only membership filtering needs it before pagination. */
export const directoryMembershipStages = (
  context: DirectoryMembership,
): PipelineStage[] => {
  const reset: PipelineStage = {
    $set: {
      activeMembership: null,
      currentMembership: null,
      membership: null,
      membershipPlan: null,
      membershipAvailable: false,
    },
  };
  if (!context.canRead) return [reset];
  return [
    reset,
    {
      $lookup: {
        from: UserMembership.collection.name,
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: { ...context.scope, $expr: { $eq: ["$user", "$$userId"] } },
          },
          membershipReportingDates as PipelineStage.Set,
          {
            $facet: {
              valid: [
                { $match: membershipReportingActive(context.now) },
                { $sort: { startedAt: -1, _id: -1 } },
                { $limit: 1 },
                {
                  $project: {
                    _id: 0,
                    name: { $ifNull: ["$planSnapshot.name", ""] },
                    status: 1,
                  },
                },
              ],
              unknown: [
                { $match: membershipReportingUnknown },
                { $limit: 1 },
                { $project: { _id: 1 } },
              ],
            },
          },
        ],
        as: "_directoryMembershipState",
      },
    },
    {
      $set: {
        membershipAvailable: {
          $or: [
            {
              $gt: [
                {
                  $size: {
                    $ifNull: [
                      { $arrayElemAt: ["$_directoryMembershipState.valid", 0] },
                      [],
                    ],
                  },
                },
                0,
              ],
            },
            {
              $eq: [
                {
                  $size: {
                    $ifNull: [
                      {
                        $arrayElemAt: ["$_directoryMembershipState.unknown", 0],
                      },
                      [],
                    ],
                  },
                },
                0,
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        activeMembership: {
          $cond: [
            "$membershipAvailable",
            {
              $ifNull: [
                {
                  $arrayElemAt: [
                    { $arrayElemAt: ["$_directoryMembershipState.valid", 0] },
                    0,
                  ],
                },
                null,
              ],
            },
            null,
          ],
        },
      },
    },
    { $unset: "_directoryMembershipState" },
  ];
};

/** Facets are names of each directory customer's latest active visible plan. */
export const getDirectoryMembershipOptions = async (
  context: DirectoryMembership,
) => {
  if (!context.canRead) return [];
  const rows = await UserMembership.aggregate([
    { $match: context.scope },
    membershipReportingDates,
    { $match: membershipReportingActive(context.now) },
    { $sort: { startedAt: -1, _id: -1 } },
    { $group: { _id: "$user", name: { $first: "$planSnapshot.name" } } },
    {
      $lookup: {
        from: User.collection.name,
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              ...customerDirectoryScope(context.tenantId),
              $expr: { $eq: ["$_id", "$$userId"] },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: "customer",
      },
    },
    { $match: { "customer.0": { $exists: true } } },
    { $group: { _id: "$name" } },
    { $sort: { _id: 1 } },
  ]);
  const options = new Map<string, string>();
  for (const row of rows) {
    const label = typeof row._id === "string" ? row._id : "";
    if (label) options.set(label.toLowerCase().replaceAll(" ", "_"), label);
  }
  return [...options]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
};
