import mongoose, { type ClientSession } from "mongoose";

import TenantModel from "@/modules/tenants/tenant.model.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import UserModel from "@/modules/user/user.model.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";

import {
  RESERVED_CUSTOM_ROLE_PERMISSIONS,
  WORKSPACE_PERMISSION,
  type WorkspacePermission,
} from "../tenant-access.permissions.js";
import { tenantAccessRepository } from "../tenant-access.repository.js";
import {
  getBuiltInRoleName,
  isBuiltInWorkspaceRole,
  listBuiltInRoles,
} from "../tenant-access.roles.js";
import {
  BUILT_IN_WORKSPACE_ROLES,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "../tenant-access.constants.js";
import { normalizeCustomRoleName } from "../tenant-custom-role.schema.js";
import TenantMembershipModel from "../tenant-membership.model.js";
import type { ResolvedWorkspaceAccess } from "../tenant-access.types.js";
import type {
  CreateCustomRoleInput,
  UpdateCustomRoleInput,
} from "../tenant-access.validators.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "./authorization.service.js";

const toObjectId = (value: unknown): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(String(value));
};

const runTransaction = async <T>(
  task: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();

  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await task(session);
    });

    if (result === undefined) {
      throw new Error("Custom role transaction completed without a result.");
    }

    return result;
  } finally {
    await session.endSession();
  }
};

const acquireTenantWriteLock = async (
  tenantId: string,
  session: ClientSession,
): Promise<void> => {
  const result = await TenantModel.updateOne(
    { _id: toObjectId(tenantId) },
    { $inc: { accessControlVersion: 1 } },
    { session },
  ).exec();

  if (!result.matchedCount) {
    notFound("Tenant not found.");
  }
};

const resolveAuthoritativeRoleManager = async ({
  tenantId,
  actorUserId,
  session,
}: {
  tenantId: string;
  actorUserId: string;
  session: ClientSession;
}): Promise<ResolvedWorkspaceAccess> => {
  const actor = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: actorUserId,
    session,
  });

  if (
    !actor ||
    actor.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE ||
    !hasWorkspacePermission(actor, WORKSPACE_PERMISSION.ROLES_MANAGE)
  ) {
    forbidden({
      message:
        "Your workspace permissions changed before this action completed.",
      code: "WORKSPACE_PERMISSION_CHANGED",
      details: { requiredPermission: WORKSPACE_PERMISSION.ROLES_MANAGE },
    });
  }

  return actor;
};

const assertCustomRoleNameIsAvailable = (name: string): string => {
  const normalizedName = normalizeCustomRoleName(name);
  const reservedNames = new Set([
    ...BUILT_IN_WORKSPACE_ROLES,
    WORKSPACE_ROLE.CUSTOM,
    ...BUILT_IN_WORKSPACE_ROLES.map((role) =>
      getBuiltInRoleName(role).toLocaleLowerCase("en-US"),
    ),
  ]);

  if (reservedNames.has(normalizedName)) {
    badRequest({
      message: "This role name is reserved for a built-in role.",
      code: "CUSTOM_ROLE_NAME_RESERVED",
    });
  }

  return normalizedName;
};

export const assertCustomRolePermissionsCanBeAssigned = ({
  actorAccess,
  permissions,
}: {
  actorAccess: ResolvedWorkspaceAccess;
  permissions: readonly WorkspacePermission[];
}): void => {
  const reserved = permissions.filter((permission) =>
    RESERVED_CUSTOM_ROLE_PERMISSIONS.includes(permission),
  );

  if (reserved.length) {
    forbidden({
      message: "One or more permissions are reserved and cannot be delegated.",
      code: "CUSTOM_ROLE_PERMISSION_RESERVED",
      details: { permissions: reserved },
    });
  }

  if (!actorAccess.isPlatformBypass) {
    const actorPermissions = new Set(actorAccess.permissions);
    const unownedPermissions = permissions.filter(
      (permission) => !actorPermissions.has(permission),
    );

    if (unownedPermissions.length) {
      forbidden({
        message: "A role cannot grant permissions you do not have.",
        code: "CUSTOM_ROLE_PRIVILEGE_ESCALATION",
        details: { permissions: unownedPermissions },
      });
    }
  }
};

const serializeCustomRole = (role: any) => ({
  roleId: String(role._id),
  roleKey: WORKSPACE_ROLE.CUSTOM,
  roleName: role.name,
  description: role.description ?? "",
  permissions: [...(role.permissions ?? [])],
  isBuiltIn: false,
  isActive: Boolean(role.isActive),
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

export const listWorkspaceRoles = async (tenantId: string) => {
  const tenant = toObjectId(tenantId);
  const [customRoles, membershipCounts] = await Promise.all([
    tenantAccessRepository.listCustomRoles(tenantId),
    TenantMembershipModel.aggregate<{
      _id: { role: string; customRole: mongoose.Types.ObjectId | null };
      count: number;
    }>([
      {
        $match: {
          tenant,
          status: { $ne: TENANT_MEMBERSHIP_STATUS.REVOKED },
        },
      },
      {
        $group: {
          _id: { role: "$role", customRole: "$customRole" },
          count: { $sum: 1 },
        },
      },
    ]).exec(),
  ]);
  const countByRole = new Map<string, number>();

  for (const item of membershipCounts) {
    const key =
      item._id.role === WORKSPACE_ROLE.CUSTOM && item._id.customRole
        ? `custom:${String(item._id.customRole)}`
        : item._id.role;
    countByRole.set(key, item.count);
  }

  return {
    roles: [
      ...listBuiltInRoles().map((role) => ({
        roleId: null,
        roleKey: role.key,
        roleName: role.name ?? role.key,
        description: "",
        permissions: [...role.permissions],
        isBuiltIn: true,
        isActive: true,
        memberCount: countByRole.get(role.key) ?? 0,
      })),
      ...customRoles.map((role) => ({
        ...serializeCustomRole(role),
        memberCount: countByRole.get(`custom:${String(role._id)}`) ?? 0,
      })),
    ],
  };
};

export const createWorkspaceCustomRole = async ({
  tenantId,
  actorUserId,
  actorAccess,
  input,
}: {
  tenantId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
  input: CreateCustomRoleInput;
}) => {
  const normalizedName = assertCustomRoleNameIsAvailable(input.name);
  let roleId: string;
  try {
    roleId = await runTransaction(async (session) => {
      await acquireTenantWriteLock(tenantId, session);
      const authoritativeActor = await resolveAuthoritativeRoleManager({
        tenantId,
        actorUserId,
        session,
      });
      const tenant = await TenantModel.findById(tenantId)
        .select("plan planVersion")
        .session(session)
        .lean()
        .exec();
      if (!tenant) notFound("Tenant not found.");
      if (
        Number(tenant.planVersion ?? 1) >= 3 &&
        getPlanConfig(tenant.plan, tenant.planVersion).capabilities?.enterprise
          .customRolesAndPermissions !== true
      ) {
        forbidden({
          message: "Custom roles are not included in the current plan.",
          code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
          details: {
            capability: "customRolesAndPermissions",
            currentPlan: tenant.plan,
            planVersion: tenant.planVersion,
          },
        });
      }
      assertCustomRolePermissionsCanBeAssigned({
        actorAccess: authoritativeActor,
        permissions: input.permissions as WorkspacePermission[],
      });

      const role = await tenantAccessRepository.createCustomRole(
        {
          tenant: toObjectId(tenantId),
          name: input.name,
          normalizedName,
          description: input.description,
          permissions: input.permissions,
          isActive: true,
          createdBy: toObjectId(actorUserId),
          updatedBy: toObjectId(actorUserId),
        },
        { session },
      );

      return String(role._id);
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 11000
    ) {
      conflict({
        message: "A custom role with this name already exists.",
        code: "CUSTOM_ROLE_NAME_EXISTS",
      });
    }

    throw error;
  }

  const role = await tenantAccessRepository.findCustomRoleById(
    tenantId,
    roleId,
  );
  if (!role) throw new Error("Custom role was created but could not be found.");
  return serializeCustomRole(role.toObject());
};

const revokeAffectedRefreshTokens = async (
  tenantId: string,
  roleId: string,
  session: ClientSession,
): Promise<void> => {
  const userIds = await TenantMembershipModel.find({
    tenant: toObjectId(tenantId),
    customRole: toObjectId(roleId),
    status: "active",
  })
    .distinct("user")
    .session(session)
    .exec();

  if (!userIds.length) return;

  await UserModel.updateMany(
    {
      tenant: toObjectId(tenantId),
      _id: { $in: userIds },
    },
    { $set: { refreshToken: [] } },
    { session },
  ).exec();
};

export const updateWorkspaceCustomRole = async ({
  tenantId,
  roleId,
  actorUserId,
  actorAccess,
  input,
}: {
  tenantId: string;
  roleId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
  input: UpdateCustomRoleInput;
}) => {
  await runTransaction(async (session) => {
    await acquireTenantWriteLock(tenantId, session);
    const authoritativeActor = await resolveAuthoritativeRoleManager({
      tenantId,
      actorUserId,
      session,
    });
    const role = await tenantAccessRepository.findCustomRoleById(
      tenantId,
      roleId,
      { session },
    );

    if (!role) {
      notFound("Custom role not found.");
    }

    if (input.name !== undefined) {
      role.name = input.name;
      role.normalizedName = assertCustomRoleNameIsAvailable(input.name);
    }
    if (input.description !== undefined) {
      role.description = input.description;
    }
    if (input.permissions !== undefined) {
      assertCustomRolePermissionsCanBeAssigned({
        actorAccess: authoritativeActor,
        permissions: input.permissions as WorkspacePermission[],
      });
      role.permissions = input.permissions as WorkspacePermission[];
    }

    role.updatedBy = toObjectId(actorUserId);

    try {
      await tenantAccessRepository.saveCustomRole(role, { session });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 11000
      ) {
        conflict("A custom role with this name already exists.");
      }
      throw error;
    }

    await TenantMembershipModel.updateMany(
      {
        tenant: toObjectId(tenantId),
        customRole: toObjectId(roleId),
      },
      { $inc: { accessVersion: 1 } },
      { session },
    ).exec();
    await revokeAffectedRefreshTokens(tenantId, roleId, session);

    return true;
  });

  const role = await tenantAccessRepository.findCustomRoleById(
    tenantId,
    roleId,
  );
  if (!role) notFound("Custom role not found.");
  return serializeCustomRole(role.toObject());
};

export const deleteWorkspaceCustomRole = async ({
  tenantId,
  roleId,
  actorUserId,
}: {
  tenantId: string;
  roleId: string;
  actorUserId: string;
}) => {
  await runTransaction(async (session) => {
    await acquireTenantWriteLock(tenantId, session);
    await resolveAuthoritativeRoleManager({
      tenantId,
      actorUserId,
      session,
    });
    const role = await tenantAccessRepository.findCustomRoleById(
      tenantId,
      roleId,
      { session },
    );

    if (!role) {
      notFound("Custom role not found.");
    }

    const usageCount =
      await tenantAccessRepository.countMembershipsUsingCustomRole(
        tenantId,
        roleId,
        { session },
      );

    if (usageCount > 0) {
      conflict({
        message: "This role is assigned to one or more active team members.",
        code: "CUSTOM_ROLE_IN_USE",
        details: { membershipCount: usageCount },
      });
    }

    await tenantAccessRepository.deleteCustomRole(tenantId, roleId, {
      session,
    });
    return true;
  });

  return { message: "Custom role deleted." };
};
