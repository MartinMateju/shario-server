import mongoose, { type ClientSession } from "mongoose";

import type { WorkspaceGuideId } from "@/modules/workspace-guides/workspace-guide.constants.js";

import {
  workspaceAccessCacheKey,
  type TenantMembershipStatus,
  type WorkspaceRole,
} from "./tenant-access.constants.js";
import TenantCustomRoleModel from "./tenant-custom-role.model.js";
import TenantMembershipModel from "./tenant-membership.model.js";
import type {
  IdLike,
  TenantCustomRoleDocument,
  TenantMembershipDocument,
} from "./tenant-access.types.js";

export type TenantAccessRepositoryOptions = {
  session?: ClientSession | null;
};

const toObjectId = (value: IdLike): mongoose.Types.ObjectId => {
  return value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));
};

const applySession = <
  TQuery extends {
    session: (session: ClientSession | null) => TQuery;
  },
>(
  query: TQuery,
  session?: ClientSession | null,
): TQuery => {
  if (session) {
    query.session(session);
  }

  return query;
};

/*
 * Loaded dynamically, rather than imported at the top of the file, so this
 * repository (imported by most of the auth/permission call graph) never
 * requires REDIS_URL to be configured just to read or write a membership.
 */
const invalidateWorkspaceAccessCache = async (key: string): Promise<void> => {
  const { deleteCache } = await import("@/infrastructure/redis/cache.js");
  await deleteCache(key);
};

const invalidateWorkspaceAccessCacheKeys = async (
  keys: readonly string[],
): Promise<void> => {
  const { deleteCacheKeys } = await import("@/infrastructure/redis/cache.js");
  await deleteCacheKeys(keys);
};

export const tenantAccessRepository = {
  findMembershipByUser(
    tenantId: IdLike,
    userId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument | null> {
    return applySession(
      TenantMembershipModel.findOne({
        tenant: toObjectId(tenantId),
        user: toObjectId(userId),
      }),
      options.session,
    ).exec();
  },

  findMembershipById(
    tenantId: IdLike,
    membershipId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument | null> {
    return applySession(
      TenantMembershipModel.findOne({
        _id: toObjectId(membershipId),
        tenant: toObjectId(tenantId),
      }),
      options.session,
    ).exec();
  },

  async listMemberships(
    tenantId: IdLike,
    filters: {
      status?: TenantMembershipStatus;
      role?: WorkspaceRole;
      page: number;
      limit: number;
    },
    options: TenantAccessRepositoryOptions = {},
  ) {
    const query = {
      tenant: toObjectId(tenantId),
      ...(filters.status
        ? { status: filters.status }
        : { status: { $ne: "revoked" as TenantMembershipStatus } }),
      ...(filters.role ? { role: filters.role } : {}),
    };
    const skip = (filters.page - 1) * filters.limit;

    const [memberships, total] = await Promise.all([
      applySession(
        TenantMembershipModel.find(query)
          .populate({
            path: "user",
            select:
              "firstname lastname email phone customId isEmailVerified isAccessGranted",
          })
          .populate({
            path: "customRole",
            select: "name description permissions isActive",
          })
          .sort({ role: 1, createdAt: 1, _id: 1 })
          .skip(skip)
          .limit(filters.limit),
        options.session,
      )
        .lean()
        .exec(),
      applySession(
        TenantMembershipModel.countDocuments(query),
        options.session,
      ).exec(),
    ]);

    return {
      memberships,
      total,
      page: filters.page,
      limit: filters.limit,
      pages: Math.ceil(total / filters.limit),
    };
  },

  countActiveStaffSeats(
    tenantId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<number> {
    return applySession(
      TenantMembershipModel.countDocuments({
        tenant: toObjectId(tenantId),
        status: "active",
        role: { $nin: ["owner", "admin"] },
      }),
      options.session,
    ).exec();
  },

  countActiveAdmins(
    tenantId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<number> {
    return applySession(
      TenantMembershipModel.countDocuments({
        tenant: toObjectId(tenantId),
        status: "active",
        role: { $in: ["owner", "admin"] },
      }),
      options.session,
    ).exec();
  },

  countActiveOwners(
    tenantId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<number> {
    return applySession(
      TenantMembershipModel.countDocuments({
        tenant: toObjectId(tenantId),
        status: "active",
        role: "owner",
      }),
      options.session,
    ).exec();
  },

  async createMembership(
    input: Record<string, unknown>,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument> {
    const membership = new TenantMembershipModel(input);
    const saved = await membership.save(
      options.session ? { session: options.session } : undefined,
    );
    await invalidateWorkspaceAccessCache(
      workspaceAccessCacheKey(saved.tenant, saved.user),
    );
    return saved;
  },

  async saveMembership(
    membership: TenantMembershipDocument,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument> {
    const saved = await membership.save(
      options.session ? { session: options.session } : undefined,
    );
    await invalidateWorkspaceAccessCache(
      workspaceAccessCacheKey(saved.tenant, saved.user),
    );
    return saved;
  },

  async updateActiveMembershipPreferencePaths(
    tenantId: IdLike,
    userId: IdLike,
    setValues: Record<string, unknown>,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument | null> {
    const updated = await applySession(
      TenantMembershipModel.findOneAndUpdate(
        {
          tenant: toObjectId(tenantId),
          user: toObjectId(userId),
          status: "active",
        },
        { $set: setValues },
        { returnDocument: "after", runValidators: true },
      ),
      options.session,
    ).exec();
    if (updated) {
      await invalidateWorkspaceAccessCache(
        workspaceAccessCacheKey(tenantId, userId),
      );
    }
    return updated;
  },

  async updateActiveMembershipPreferencePathsUnlessGuideCompleted(
    tenantId: IdLike,
    userId: IdLike,
    {
      guideId,
      version,
      setValues,
    }: {
      guideId: WorkspaceGuideId;
      version: number;
      setValues: Record<string, unknown>;
    },
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantMembershipDocument | null> {
    const guidePath = `preferences.contextualGuides.${guideId}`;

    const updated = await applySession(
      TenantMembershipModel.findOneAndUpdate(
        {
          tenant: toObjectId(tenantId),
          user: toObjectId(userId),
          status: "active",
          $or: [
            { [`${guidePath}.status`]: { $ne: "completed" } },
            { [`${guidePath}.version`]: { $ne: version } },
          ],
        },
        { $set: setValues },
        { returnDocument: "after", runValidators: true },
      ),
      options.session,
    ).exec();
    if (updated) {
      await invalidateWorkspaceAccessCache(
        workspaceAccessCacheKey(tenantId, userId),
      );
    }
    return updated;
  },

  findCustomRoleById(
    tenantId: IdLike,
    roleId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantCustomRoleDocument | null> {
    return applySession(
      TenantCustomRoleModel.findOne({
        _id: toObjectId(roleId),
        tenant: toObjectId(tenantId),
      }),
      options.session,
    ).exec();
  },

  findCustomRoleByNormalizedName(
    tenantId: IdLike,
    normalizedName: string,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantCustomRoleDocument | null> {
    return applySession(
      TenantCustomRoleModel.findOne({
        tenant: toObjectId(tenantId),
        normalizedName,
      }),
      options.session,
    ).exec();
  },

  listCustomRoles(
    tenantId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ) {
    return applySession(
      TenantCustomRoleModel.find({
        tenant: toObjectId(tenantId),
        isActive: true,
      }).sort({ name: 1, _id: 1 }),
      options.session,
    )
      .lean()
      .exec();
  },

  createCustomRole(
    input: Record<string, unknown>,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantCustomRoleDocument> {
    const role = new TenantCustomRoleModel(input);
    return role.save(
      options.session ? { session: options.session } : undefined,
    );
  },

  async saveCustomRole(
    role: TenantCustomRoleDocument,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<TenantCustomRoleDocument> {
    const saved = await role.save(
      options.session ? { session: options.session } : undefined,
    );
    // A role's permission set (or active flag) applies to every member
    // assigned it, not just the actor who edited it.
    await invalidateMembersUsingCustomRole(saved.tenant, saved._id, options);
    return saved;
  },

  countMembershipsUsingCustomRole(
    tenantId: IdLike,
    roleId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ): Promise<number> {
    return applySession(
      TenantMembershipModel.countDocuments({
        tenant: toObjectId(tenantId),
        customRole: toObjectId(roleId),
        status: { $ne: "revoked" },
      }),
      options.session,
    ).exec();
  },

  async deleteCustomRole(
    tenantId: IdLike,
    roleId: IdLike,
    options: TenantAccessRepositoryOptions = {},
  ) {
    // Invalidate before deleting: once the role document is gone, a member
    // whose cache entry we haven't busted yet would keep serving permissions
    // for a role that no longer resolves.
    await invalidateMembersUsingCustomRole(tenantId, roleId, options);
    return applySession(
      TenantCustomRoleModel.deleteOne({
        _id: toObjectId(roleId),
        tenant: toObjectId(tenantId),
      }),
      options.session,
    ).exec();
  },
};

/**
 * Busts the cached workspace access of every member currently assigned
 * `roleId`, so an edit or deletion of a custom role's permissions takes
 * effect immediately rather than waiting out the cache TTL.
 */
const invalidateMembersUsingCustomRole = async (
  tenantId: IdLike,
  roleId: IdLike,
  options: TenantAccessRepositoryOptions = {},
): Promise<void> => {
  const members = await applySession(
    TenantMembershipModel.find({
      tenant: toObjectId(tenantId),
      customRole: toObjectId(roleId),
    }).select("user"),
    options.session,
  )
    .lean()
    .exec();

  await invalidateWorkspaceAccessCacheKeys(
    members.map((member) => workspaceAccessCacheKey(tenantId, member.user)),
  );
};
