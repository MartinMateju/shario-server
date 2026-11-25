import mongoose from "mongoose";
import UserMembership from "@/modules/membership/user-membership.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import { getReportPlanEntitlement } from "@/modules/reports/report-plan-entitlements.js";
import {
  buildMembershipReportingLocationFilter,
  membershipReportingActive,
  membershipReportingDates,
  membershipReportingUnknown,
} from "@/modules/membership/membership-reporting.js";
import {
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION as P } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

type Context = {
  tenantId: string;
  access?: ResolvedWorkspaceAccess | null;
  now?: Date;
};
const canRead = async ({ tenantId, access }: Context) => {
  if (access?.tenantId !== tenantId ||
      !hasWorkspacePermission(access, P.CUSTOMERS_VIEW) ||
      !hasWorkspacePermission(access, P.MEMBERSHIPS_VIEW)) return false;
  const tenant = await Tenant.findById(tenantId).select("modules plan planVersion").lean();
  return tenant?.modules?.memberships === true && getReportPlanEntitlement({
    plan: tenant.plan as TenantPlan, planVersion: Number(tenant.planVersion ?? 1),
  }).studioOperations;
};
const matchMemberships = ({ tenantId, access }: Context) => {
  const locations = getAllowedWorkspaceLocationIds(access);
  return {
    tenant: new mongoose.Types.ObjectId(tenantId),
    status: { $in: ["active", "cancel_scheduled"] },
    ...buildMembershipReportingLocationFilter(
      locations === null ? null : locations.map((id) => new mongoose.Types.ObjectId(id)),
    ),
  };
};

// Shared read predicates keep the paginated directory aligned with reporting.
export { canRead as canReadCustomerMemberships, matchMemberships as customerMembershipScope };

/** This aggregate never depends on a page of customers or the directory filters. */
export const getCustomerMembershipSummary = async (context: Context) => {
  const now = context.now ?? new Date();
  const metadata = {
    membershipScope: getAllowedWorkspaceLocationIds(context.access) === null
      ? "workspace" as const : "authorized_locations" as const,
    asOf: now.toISOString(),
  };
  if (!await canRead(context)) return { ...metadata, activeMemberships: null };
  const [result] = await UserMembership.aggregate<{
    active: { count: number }[]; unknown: { _id: unknown }[];
  }>([
    { $match: matchMemberships(context) },
    membershipReportingDates,
    { $facet: {
      active: [
        { $match: membershipReportingActive(now) },
        { $group: { _id: "$user" } },
        { $count: "count" },
      ],
      unknown: [{ $match: membershipReportingUnknown }, { $limit: 1 }, { $project: { _id: 1 } }],
    } },
  ]);
  return {
    ...metadata,
    activeMemberships: result?.unknown.length ? null : (result?.active[0]?.count ?? 0),
  };
};

/** Names/status only: never expose contracts, prices or a different studio's plan. */
export const withCustomerMemberships = async <T extends Record<string, any>>(
  context: Context & { users: T[] },
): Promise<(T & { activeMembership: { name: string; status: string } | null })[]> => {
  const memberships = new Map<string, { name: string; status: string }>();
  const userIds = context.users.map((user) => String(user._id ?? ""))
    .filter(mongoose.isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
  if (userIds.length && await canRead(context)) {
    const rows = await UserMembership.aggregate<{ _id: mongoose.Types.ObjectId; name: string; status: string }>([
      { $match: { ...matchMemberships(context), user: { $in: userIds } } },
      membershipReportingDates,
      { $match: membershipReportingActive(context.now ?? new Date()) },
      { $sort: { startedAt: -1, _id: -1 } },
      { $group: { _id: "$user", name: { $first: "$planSnapshot.name" }, status: { $first: "$status" } } },
    ]);
    for (const row of rows) memberships.set(String(row._id), { name: row.name || "", status: row.status });
  }
  return context.users.map((user) => ({ ...user, activeMembership: memberships.get(String(user._id)) ?? null }));
};
