import mongoose, { type ClientSession } from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { getTeamAccountCapacity } from "@/modules/tenants/tenant-plan-usage.js";
import UserModel from "@/modules/user/user.model.js";
import { TENANT_ROLE, type TenantRole } from "@/modules/user/user.constants.js";
import {
  WORKSPACE_GUIDE_STATUS,
  type WorkspaceGuideId,
} from "@/modules/workspace-guides/workspace-guide.constants.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";

import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
  type WorkspaceRole,
} from "../tenant-access.constants.js";
import {
  WORKSPACE_PERMISSION,
  type WorkspacePermission,
} from "../tenant-access.permissions.js";
import { tenantAccessRepository } from "../tenant-access.repository.js";
import TenantMembershipModel from "../tenant-membership.model.js";
import {
  getBuiltInRoleName,
  isBuiltInWorkspaceRole,
} from "../tenant-access.roles.js";
import type {
  ResolvedWorkspaceAccess,
  TenantMembershipDocument,
  WorkspaceLocationAccess,
} from "../tenant-access.types.js";
import type {
  CreateTeamMemberInput,
  ListTeamMembersInput,
  UpdateTeamMemberInput,
  WorkspacePreferencesInput,
} from "../tenant-access.validators.js";
import {
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
  serializeWorkspaceAccess,
} from "./authorization.service.js";

const toObjectId = (value: unknown): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(String(value));
};

const isDuplicateKeyError = (error: unknown): boolean => {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000,
  );
};

export const runTenantAccessTransaction = async <T>(
  task: (session: ClientSession) => Promise<T>,
  existingSession?: ClientSession | null,
): Promise<T> => {
  if (existingSession) {
    return task(existingSession);
  }

  const session = await mongoose.startSession();

  try {
    let result: T | undefined;

    await session.withTransaction(async () => {
      result = await task(session);
    });

    if (result === undefined) {
      throw new Error("Tenant access transaction completed without a result.");
    }

    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * The first write in every membership mutation serializes concurrent owner and
 * seat-limit changes for the tenant. MongoDB will retry transient transaction
 * conflicts through withTransaction().
 */
export const acquireTenantAccessWriteLock = async (
  tenantId: string,
  session: ClientSession,
) => {
  const tenant = await TenantModel.findOneAndUpdate(
    { _id: toObjectId(tenantId) },
    { $inc: { accessControlVersion: 1 } },
    { returnDocument: "after", session, runValidators: true },
  ).exec();

  if (!tenant) {
    notFound("Tenant not found.");
  }

  return tenant;
};

const normalizeLocationAccess = (input: {
  mode: string;
  locationIds?: string[];
}): WorkspaceLocationAccess => ({
  mode:
    input.mode === LOCATION_ACCESS_MODE.SELECTED
      ? LOCATION_ACCESS_MODE.SELECTED
      : LOCATION_ACCESS_MODE.ALL,
  locationIds:
    input.mode === LOCATION_ACCESS_MODE.SELECTED
      ? [...new Set(input.locationIds ?? [])]
      : [],
});

export const assertLocationAccessIsValid = async ({
  tenantId,
  role,
  locationAccess,
  session,
}: {
  tenantId: string;
  role: WorkspaceRole;
  locationAccess: WorkspaceLocationAccess;
  session: ClientSession;
}): Promise<WorkspaceLocationAccess> => {
  if (role === WORKSPACE_ROLE.OWNER) {
    if (locationAccess.mode !== LOCATION_ACCESS_MODE.ALL) {
      badRequest({
        message: "Workspace owners must have access to all locations.",
        code: "OWNER_LOCATION_ACCESS_RESTRICTED",
      });
    }

    return { mode: LOCATION_ACCESS_MODE.ALL, locationIds: [] };
  }

  if (locationAccess.mode === LOCATION_ACCESS_MODE.ALL) {
    return { mode: LOCATION_ACCESS_MODE.ALL, locationIds: [] };
  }

  const locationIds = [...new Set(locationAccess.locationIds)];

  if (!locationIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
    badRequest("One or more selected locations are invalid.");
  }

  const matchingLocations = await LocationModel.countDocuments({
    _id: { $in: locationIds.map(toObjectId) },
    tenant: toObjectId(tenantId),
  })
    .session(session)
    .exec();

  if (matchingLocations !== locationIds.length) {
    badRequest({
      message:
        "One or more selected locations do not belong to this workspace.",
      code: "WORKSPACE_LOCATION_SCOPE_INVALID",
    });
  }

  return {
    mode: LOCATION_ACCESS_MODE.SELECTED,
    locationIds,
  };
};

export const resolveCustomRoleId = async ({
  tenantId,
  role,
  requestedCustomRoleId,
  currentCustomRoleId,
  session,
}: {
  tenantId: string;
  role: WorkspaceRole;
  requestedCustomRoleId?: string | null;
  currentCustomRoleId?: unknown;
  session: ClientSession;
}): Promise<mongoose.Types.ObjectId | null> => {
  if (role !== WORKSPACE_ROLE.CUSTOM) {
    return null;
  }

  const roleId =
    requestedCustomRoleId === undefined
      ? String(currentCustomRoleId ?? "")
      : String(requestedCustomRoleId ?? "");

  if (!roleId || !mongoose.Types.ObjectId.isValid(roleId)) {
    badRequest({
      message: "A valid custom role is required.",
      code: "CUSTOM_ROLE_REQUIRED",
    });
  }

  const customRole = await tenantAccessRepository.findCustomRoleById(
    tenantId,
    roleId,
    { session },
  );

  if (!customRole?.isActive) {
    badRequest({
      message: "The selected custom role is not active.",
      code: "CUSTOM_ROLE_INACTIVE",
    });
  }

  return customRole._id;
};

const isAdminSeat = (role: WorkspaceRole): boolean => {
  return role === WORKSPACE_ROLE.OWNER || role === WORKSPACE_ROLE.ADMIN;
};

export const assertPlanSeatLimits = async ({
  tenant,
  currentRole,
  currentStatus,
  nextRole,
  nextStatus,
  session,
}: {
  tenant: any;
  currentRole?: WorkspaceRole;
  currentStatus?: string;
  nextRole: WorkspaceRole;
  nextStatus: string;
  session: ClientSession;
}): Promise<void> => {
  const tenantId = String(tenant._id);
  const [activeStaff, activeAdmins] = await Promise.all([
    tenantAccessRepository.countActiveStaffSeats(tenantId, { session }),
    tenantAccessRepository.countActiveAdmins(tenantId, { session }),
  ]);

  const wasActive = currentStatus === TENANT_MEMBERSHIP_STATUS.ACTIVE;
  const willBeActive = nextStatus === TENANT_MEMBERSHIP_STATUS.ACTIVE;
  const wasAdmin = wasActive && currentRole ? isAdminSeat(currentRole) : false;
  const willBeAdmin = willBeActive && isAdminSeat(nextRole);
  const adminDelta = Number(willBeAdmin) - Number(wasAdmin);
  const wasStaff = wasActive && currentRole ? !isAdminSeat(currentRole) : false;
  const willBeStaff = willBeActive && !isAdminSeat(nextRole);
  const staffDelta = Number(willBeStaff) - Number(wasStaff);
  const staffLimit = Math.max(Number(tenant.limits?.staffMembers ?? 1), 1);
  const adminLimit = Math.max(Number(tenant.limits?.admins ?? 1), 1);
  const teamAccountCapacity = getTeamAccountCapacity({
    planVersion: tenant.planVersion,
    activeAdmins,
    activeStaff,
    wasActive,
    willBeActive,
    limit: staffLimit,
  });

  // Plan V2 defines one customer-facing team-account allowance that includes
  // the owner. V1 retains its original separate staff/admin seat semantics so
  // existing tenants are never restricted by a newly interpreted limit.
  if (teamAccountCapacity.exceeded) {
    conflict({
      message: "Your current plan has reached its active team account limit.",
      code: "TEAM_ACCOUNT_LIMIT_REACHED",
      details: {
        activeTeamAccounts: teamAccountCapacity.current,
        teamAccountLimit: teamAccountCapacity.limit,
        plan: tenant.plan,
        planVersion: tenant.planVersion,
        upgradeRequired: true,
      },
    });
  }

  if (staffDelta > 0 && activeStaff + staffDelta > staffLimit) {
    conflict({
      message: "Your current plan has reached its active team member limit.",
      code: "STAFF_MEMBER_LIMIT_REACHED",
      details: {
        activeStaff,
        staffLimit,
        plan: tenant.plan,
        upgradeRequired: true,
      },
    });
  }

  if (adminDelta > 0 && activeAdmins + adminDelta > adminLimit) {
    conflict({
      message: "Your current plan has reached its administrator limit.",
      code: "ADMIN_LIMIT_REACHED",
      details: {
        activeAdmins,
        adminLimit,
        plan: tenant.plan,
        upgradeRequired: true,
      },
    });
  }
};

const compatibilityTenantRole = (
  role: WorkspaceRole,
  status: string,
): TenantRole => {
  if (status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    return TENANT_ROLE.CUSTOMER;
  }

  if (role === WORKSPACE_ROLE.OWNER) return TENANT_ROLE.OWNER;
  if (role === WORKSPACE_ROLE.ADMIN) return TENANT_ROLE.ADMIN;
  return TENANT_ROLE.STAFF;
};

const mirrorUserCompatibilityAccess = async ({
  tenantId,
  userId,
  role,
  status,
  session,
}: {
  tenantId: string;
  userId: unknown;
  role: WorkspaceRole;
  status: string;
  session: ClientSession;
}): Promise<void> => {
  await UserModel.updateOne(
    {
      _id: toObjectId(userId),
      tenant: toObjectId(tenantId),
    },
    {
      $set: {
        tenantRole: compatibilityTenantRole(role, status),
        refreshToken: [],
      },
    },
    { session },
  ).exec();
};

const requireActorCanManageOwners = (
  actor: ResolvedWorkspaceAccess,
  currentRole?: WorkspaceRole,
  nextRole?: WorkspaceRole,
): void => {
  const affectsOwner =
    currentRole === WORKSPACE_ROLE.OWNER || nextRole === WORKSPACE_ROLE.OWNER;

  if (
    affectsOwner &&
    !actor.isPlatformBypass &&
    actor.role !== WORKSPACE_ROLE.OWNER
  ) {
    forbidden({
      message: "Only a workspace owner can assign or modify another owner.",
      code: "OWNER_ROLE_REQUIRED",
    });
  }
};

export const assertActorCanGrantLocationAccess = (
  actor: ResolvedWorkspaceAccess,
  requestedAccess: WorkspaceLocationAccess,
): void => {
  if (
    actor.isPlatformBypass ||
    actor.locationAccess.mode === LOCATION_ACCESS_MODE.ALL
  ) {
    return;
  }

  if (requestedAccess.mode === LOCATION_ACCESS_MODE.ALL) {
    forbidden({
      message:
        "You cannot grant access to locations outside your own assignment.",
      code: "WORKSPACE_LOCATION_SCOPE_ESCALATION",
    });
  }

  const actorLocationIds = new Set(
    actor.locationAccess.locationIds.map(String),
  );
  const hasOutOfScopeLocation = requestedAccess.locationIds.some(
    (locationId) => !actorLocationIds.has(String(locationId)),
  );

  if (hasOutOfScopeLocation) {
    forbidden({
      message:
        "You cannot grant access to locations outside your own assignment.",
      code: "WORKSPACE_LOCATION_SCOPE_ESCALATION",
    });
  }
};

export const resolveAuthoritativeActor = async ({
  tenantId,
  actorUserId,
  permission,
  session,
}: {
  tenantId: string;
  actorUserId: string;
  permission: WorkspacePermission;
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
    !hasWorkspacePermission(actor, permission)
  ) {
    forbidden({
      message:
        "Your workspace permissions changed before this action completed.",
      code: "WORKSPACE_PERMISSION_CHANGED",
      details: { requiredPermission: permission },
    });
  }

  return actor;
};

const assertLastOwnerIsPreserved = async ({
  tenantId,
  membership,
  nextRole,
  nextStatus,
  session,
}: {
  tenantId: string;
  membership: TenantMembershipDocument;
  nextRole: WorkspaceRole;
  nextStatus: string;
  session: ClientSession;
}): Promise<void> => {
  const currentlyActiveOwner =
    membership.role === WORKSPACE_ROLE.OWNER &&
    membership.status === TENANT_MEMBERSHIP_STATUS.ACTIVE;
  const remainsActiveOwner =
    nextRole === WORKSPACE_ROLE.OWNER &&
    nextStatus === TENANT_MEMBERSHIP_STATUS.ACTIVE;

  if (!currentlyActiveOwner || remainsActiveOwner) {
    return;
  }

  const ownerCount = await tenantAccessRepository.countActiveOwners(tenantId, {
    session,
  });

  if (ownerCount <= 1) {
    conflict({
      message: "A workspace must always have at least one active owner.",
      code: "LAST_WORKSPACE_OWNER_REQUIRED",
    });
  }
};

const getPopulatedMembership = async (
  tenantId: string,
  membershipId: string,
  session?: ClientSession | null,
) => {
  const query = TenantMembershipModel.findOne({
    _id: toObjectId(membershipId),
    tenant: toObjectId(tenantId),
  })
    .populate({
      path: "user",
      select:
        "firstname lastname email phone customId isEmailVerified isAccessGranted",
    })
    .populate({
      path: "customRole",
      select: "name description permissions isActive",
    });

  if (session) query.session(session);
  return query.lean().exec();
};

const serializeTeamMembership = (membership: any) => {
  const customRole =
    membership?.customRole && typeof membership.customRole === "object"
      ? membership.customRole
      : null;
  const roleKey = membership.role as WorkspaceRole;
  const user =
    membership?.user && typeof membership.user === "object"
      ? membership.user
      : null;

  return {
    membershipId: String(membership._id),
    status: membership.status,
    roleKey,
    roleName:
      customRole?.name ??
      (isBuiltInWorkspaceRole(roleKey)
        ? getBuiltInRoleName(roleKey)
        : "Custom role"),
    customRoleId: customRole?._id
      ? String(customRole._id)
      : membership.customRole
        ? String(membership.customRole)
        : null,
    user: user
      ? {
          id: String(user._id),
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email,
          phone: user.phone,
          customId: user.customId,
          isEmailVerified: Boolean(user.isEmailVerified),
          isAccessGranted: user.isAccessGranted !== false,
        }
      : { id: String(membership.user) },
    locationAccess: {
      mode: membership.locationAccess?.mode ?? LOCATION_ACCESS_MODE.ALL,
      locationIds: (membership.locationAccess?.locationIds ?? []).map(String),
    },
    workspaceProfile: {
      jobTitle: membership.workspaceProfile?.jobTitle ?? "",
      displayName: membership.workspaceProfile?.displayName ?? "",
      calendarColor: membership.workspaceProfile?.calendarColor ?? "#74869a",
    },
    preferences: {
      ...membership.preferences,
      defaultLocation: membership.preferences?.defaultLocation
        ? String(membership.preferences.defaultLocation)
        : null,
    },
    authorizationVersion: Math.max(Number(membership.accessVersion ?? 1), 1),
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  };
};

export const listTeamMembers = async ({
  tenantId,
  input,
}: {
  tenantId: string;
  input: ListTeamMembersInput;
}) => {
  const result = await tenantAccessRepository.listMemberships(tenantId, input);

  return {
    ...result,
    memberships: result.memberships.map(serializeTeamMembership),
  };
};

export const getTeamMember = async ({
  tenantId,
  membershipId,
  session,
}: {
  tenantId: string;
  membershipId: string;
  session?: ClientSession;
}) => {
  const membership = await getPopulatedMembership(tenantId, membershipId, session);

  if (!membership) {
    notFound("Team member not found.");
  }

  return serializeTeamMembership(membership);
};

export const addExistingTenantUserToTeam = async ({
  tenantId,
  actorUserId,
  actorAccess,
  input,
  session: existingSession,
}: {
  tenantId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
  input: CreateTeamMemberInput;
  session?: ClientSession;
}) => {
  const membershipId = await runTenantAccessTransaction(async (session) => {
    const tenant = await acquireTenantAccessWriteLock(tenantId, session);
    const authoritativeActor = await resolveAuthoritativeActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    const user = await UserModel.findOne({
      tenant: toObjectId(tenantId),
      email: input.email.trim().toLowerCase(),
    })
      .select("+tenantRole")
      .session(session)
      .exec();

    if (!user) {
      notFound({
        message: "No existing workspace user was found for this email address.",
        code: "TENANT_USER_NOT_FOUND",
      });
    }

    const existingMembership =
      await tenantAccessRepository.findMembershipByUser(tenantId, user._id, {
        session,
      });

    if (
      existingMembership &&
      existingMembership.status !== TENANT_MEMBERSHIP_STATUS.REVOKED
    ) {
      conflict({
        message: "This user already has a workspace membership.",
        code: "TENANT_MEMBERSHIP_EXISTS",
      });
    }

    const role = input.roleKey;
    requireActorCanManageOwners(
      authoritativeActor,
      existingMembership?.role,
      role,
    );

    const locationAccess = await assertLocationAccessIsValid({
      tenantId,
      role,
      locationAccess: normalizeLocationAccess(input.locationAccess),
      session,
    });
    assertActorCanGrantLocationAccess(authoritativeActor, locationAccess);
    const customRole = await resolveCustomRoleId({
      tenantId,
      role,
      requestedCustomRoleId: input.customRoleId,
      session,
    });

    await assertPlanSeatLimits({
      tenant,
      currentRole: existingMembership?.role,
      currentStatus: existingMembership?.status,
      nextRole: role,
      nextStatus: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      session,
    });

    let membership: TenantMembershipDocument;

    if (existingMembership) {
      membership = existingMembership;
      membership.status = TENANT_MEMBERSHIP_STATUS.ACTIVE;
      membership.role = role;
      membership.customRole = customRole;
      membership.locationAccess.mode = locationAccess.mode;
      membership.locationAccess.locationIds =
        locationAccess.locationIds.map(toObjectId);
      membership.workspaceProfile.jobTitle =
        input.workspaceProfile?.jobTitle ?? "";
      membership.workspaceProfile.displayName =
        input.workspaceProfile?.displayName ?? "";
      membership.workspaceProfile.calendarColor =
        input.workspaceProfile?.calendarColor ?? "#74869a";
      membership.updatedBy = toObjectId(actorUserId);
      membership.acceptedAt = new Date();
      membership.accessVersion = Math.max(
        Number(membership.accessVersion ?? 1) + 1,
        2,
      );
      await tenantAccessRepository.saveMembership(membership, { session });
    } else {
      try {
        membership = await tenantAccessRepository.createMembership(
          {
            tenant: toObjectId(tenantId),
            user: user._id,
            status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
            role,
            customRole,
            locationAccess: {
              mode: locationAccess.mode,
              locationIds: locationAccess.locationIds.map(toObjectId),
            },
            workspaceProfile: input.workspaceProfile ?? {},
            createdBy: toObjectId(actorUserId),
            updatedBy: toObjectId(actorUserId),
            acceptedAt: new Date(),
          },
          { session },
        );
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          conflict("This user already has a workspace membership.");
        }
        throw error;
      }
    }

    await mirrorUserCompatibilityAccess({
      tenantId,
      userId: user._id,
      role,
      status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      session,
    });

    return String(membership._id);
  }, existingSession);

  return getTeamMember({ tenantId, membershipId, session: existingSession });
};

const mutateTeamMember = async ({
  tenantId,
  membershipId,
  actorUserId,
  actorAccess,
  input,
  revoke,
}: {
  tenantId: string;
  membershipId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
  input: UpdateTeamMemberInput;
  revoke?: boolean;
}) => {
  await runTenantAccessTransaction(async (session) => {
    const tenant = await acquireTenantAccessWriteLock(tenantId, session);
    const authoritativeActor = await resolveAuthoritativeActor({
      tenantId,
      actorUserId,
      permission: WORKSPACE_PERMISSION.TEAM_MANAGE,
      session,
    });
    const membership = await tenantAccessRepository.findMembershipById(
      tenantId,
      membershipId,
      { session },
    );

    if (!membership) {
      notFound("Team member not found.");
    }

    const nextRole = input.roleKey ?? membership.role;
    const nextStatus = revoke
      ? TENANT_MEMBERSHIP_STATUS.REVOKED
      : (input.status ?? membership.status);

    requireActorCanManageOwners(authoritativeActor, membership.role, nextRole);
    await assertLastOwnerIsPreserved({
      tenantId,
      membership,
      nextRole,
      nextStatus,
      session,
    });

    const requestedLocationAccess = input.locationAccess
      ? normalizeLocationAccess(input.locationAccess)
      : {
          mode: membership.locationAccess.mode,
          locationIds: membership.locationAccess.locationIds.map(String),
        };
    const locationAccess = await assertLocationAccessIsValid({
      tenantId,
      role: nextRole,
      locationAccess: requestedLocationAccess,
      session,
    });
    assertActorCanGrantLocationAccess(authoritativeActor, locationAccess);
    const customRole = await resolveCustomRoleId({
      tenantId,
      role: nextRole,
      requestedCustomRoleId: input.customRoleId,
      currentCustomRoleId: membership.customRole,
      session,
    });

    await assertPlanSeatLimits({
      tenant,
      currentRole: membership.role,
      currentStatus: membership.status,
      nextRole,
      nextStatus,
      session,
    });

    membership.role = nextRole;
    membership.status = nextStatus;
    membership.customRole = customRole;
    membership.locationAccess.mode = locationAccess.mode;
    membership.locationAccess.locationIds =
      locationAccess.locationIds.map(toObjectId);

    if (input.workspaceProfile) {
      if (input.workspaceProfile.jobTitle !== undefined) {
        membership.workspaceProfile.jobTitle = input.workspaceProfile.jobTitle;
      }
      if (input.workspaceProfile.displayName !== undefined) {
        membership.workspaceProfile.displayName =
          input.workspaceProfile.displayName;
      }
      if (input.workspaceProfile.calendarColor !== undefined) {
        membership.workspaceProfile.calendarColor =
          input.workspaceProfile.calendarColor;
      }
    }

    membership.updatedBy = toObjectId(actorUserId);
    membership.accessVersion = Math.max(
      Number(membership.accessVersion ?? 1) + 1,
      2,
    );

    await tenantAccessRepository.saveMembership(membership, { session });
    await mirrorUserCompatibilityAccess({
      tenantId,
      userId: membership.user,
      role: nextRole,
      status: nextStatus,
      session,
    });

    return true;
  });

  return getTeamMember({ tenantId, membershipId });
};

export const updateTeamMember = (input: {
  tenantId: string;
  membershipId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
  input: UpdateTeamMemberInput;
}) => mutateTeamMember(input);

export const revokeTeamMember = (input: {
  tenantId: string;
  membershipId: string;
  actorUserId: string;
  actorAccess: ResolvedWorkspaceAccess;
}) => mutateTeamMember({ ...input, input: {}, revoke: true });

export const updateCurrentWorkspacePreferences = async ({
  tenantId,
  userId,
  input,
}: {
  tenantId: string;
  userId: string;
  input: WorkspacePreferencesInput;
}) => {
  const membership = await tenantAccessRepository.findMembershipByUser(
    tenantId,
    userId,
  );

  if (!membership || membership.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    forbidden("An active workspace membership is required.");
  }

  if (input.defaultLocation) {
    const locationExists = await LocationModel.exists({
      _id: toObjectId(input.defaultLocation),
      tenant: toObjectId(tenantId),
    });

    if (!locationExists) {
      badRequest("Default location does not belong to this workspace.");
    }

    if (
      membership.locationAccess.mode === LOCATION_ACCESS_MODE.SELECTED &&
      !membership.locationAccess.locationIds
        .map(String)
        .includes(input.defaultLocation)
    ) {
      forbidden("Default location is outside your assigned location access.");
    }
  }

  const setValues: Record<string, unknown> = {};
  const skippedContextualGuides: Array<{
    guideId: WorkspaceGuideId;
    version: number;
    preferencePath: string;
    value: Record<string, unknown>;
  }> = [];

  if (input.language !== undefined) {
    setValues["preferences.language"] = input.language;
  }
  if (input.displayTimezone !== undefined) {
    setValues["preferences.displayTimezone"] = input.displayTimezone;
  }
  if (input.defaultLocation !== undefined) {
    setValues["preferences.defaultLocation"] = input.defaultLocation
      ? toObjectId(input.defaultLocation)
      : null;
  }
  if (input.defaultCalendarView !== undefined) {
    setValues["preferences.defaultCalendarView"] = input.defaultCalendarView;
  }
  if (input.weekStartsOn !== undefined) {
    setValues["preferences.weekStartsOn"] = input.weekStartsOn;
  }
  if (input.defaultLandingPage !== undefined) {
    setValues["preferences.defaultLandingPage"] = input.defaultLandingPage;
  }
  if (input.overviewLaunchCenterDismissed !== undefined) {
    setValues["preferences.overviewLaunchCenterDismissed"] =
      input.overviewLaunchCenterDismissed;
  }
  if (input.productTour) {
    setValues["preferences.productTour"] = {
      ...input.productTour,
      updatedAt: new Date(),
    };
  }
  if (input.firstBookingCelebrationSeen !== undefined) {
    setValues["preferences.firstBookingCelebrationSeen"] =
      input.firstBookingCelebrationSeen;
  }
  if (input.contextualGuides) {
    const updatedAt = new Date();

    for (const [guideId, state] of Object.entries(input.contextualGuides)) {
      if (!state) continue;

      const preferencePath = `preferences.contextualGuides.${guideId}`;
      const value = { ...state, updatedAt };

      if (state.status === WORKSPACE_GUIDE_STATUS.SKIPPED) {
        skippedContextualGuides.push({
          guideId: guideId as WorkspaceGuideId,
          version: state.version,
          preferencePath,
          value,
        });
      } else {
        setValues[preferencePath] = value;
      }
    }
  }
  if (input.notifications) {
    for (const [key, value] of Object.entries(input.notifications)) {
      if (value !== undefined) {
        setValues[`preferences.notifications.${key}`] = value;
      }
    }
  }

  const updatedBy = toObjectId(userId);

  if (Object.keys(setValues).length) {
    setValues.updatedBy = updatedBy;
    const updated =
      await tenantAccessRepository.updateActiveMembershipPreferencePaths(
        tenantId,
        userId,
        setValues,
      );

    if (!updated) {
      forbidden("An active workspace membership is required.");
    }
  }

  for (const guide of skippedContextualGuides) {
    await tenantAccessRepository
      .updateActiveMembershipPreferencePathsUnlessGuideCompleted(
        tenantId,
        userId,
        {
          guideId: guide.guideId,
          version: guide.version,
          setValues: {
            updatedBy,
            [guide.preferencePath]: guide.value,
          },
        },
      );
  }

  const access = await resolveWorkspaceAccessForUser({ tenantId, userId });

  if (!access || access.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    forbidden("An active workspace membership is required.");
  }

  return serializeWorkspaceAccess(access);
};

export const createOwnerMembership = async ({
  tenantId,
  userId,
  session = null,
}: {
  tenantId: string;
  userId: string;
  session?: ClientSession | null;
}): Promise<ResolvedWorkspaceAccess> => {
  await runTenantAccessTransaction(async (activeSession) => {
    await acquireTenantAccessWriteLock(tenantId, activeSession);

    const existing = await tenantAccessRepository.findMembershipByUser(
      tenantId,
      userId,
      { session: activeSession },
    );

    if (existing) {
      if (
        existing.role !== WORKSPACE_ROLE.OWNER ||
        existing.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE
      ) {
        conflict("The user already has a non-owner workspace membership.");
      }
      return true;
    }

    await tenantAccessRepository.createMembership(
      {
        tenant: toObjectId(tenantId),
        user: toObjectId(userId),
        status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
        role: WORKSPACE_ROLE.OWNER,
        customRole: null,
        locationAccess: {
          mode: LOCATION_ACCESS_MODE.ALL,
          locationIds: [],
        },
        createdBy: toObjectId(userId),
        updatedBy: toObjectId(userId),
        acceptedAt: new Date(),
      },
      { session: activeSession },
    );

    await mirrorUserCompatibilityAccess({
      tenantId,
      userId,
      role: WORKSPACE_ROLE.OWNER,
      status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      session: activeSession,
    });

    return true;
  }, session);

  const access = await resolveWorkspaceAccessForUser({
    tenantId,
    userId,
    session,
  });

  if (!access) {
    throw new Error("Owner membership was created but could not be resolved.");
  }

  return access;
};

type LegacyWorkspaceUser = {
  _id?: unknown;
  id?: unknown;
  tenantRole?: unknown;
};

const legacyRoleToWorkspaceRole = (
  tenantRole: unknown,
): WorkspaceRole | null => {
  switch (tenantRole) {
    case TENANT_ROLE.OWNER:
      return WORKSPACE_ROLE.OWNER;
    case TENANT_ROLE.ADMIN:
      return WORKSPACE_ROLE.ADMIN;
    case TENANT_ROLE.STAFF:
      return WORKSPACE_ROLE.STAFF;
    default:
      return null;
  }
};

/**
 * Idempotent auth-rollout bridge. Existing tenant users can sign in before the
 * batch migration runs. Duplicate-key races resolve the winning membership.
 */
export const ensureLegacyWorkspaceMembershipForUser = async ({
  tenantId,
  user,
  session = null,
}: {
  tenantId: string;
  user: LegacyWorkspaceUser;
  session?: ClientSession | null;
}): Promise<ResolvedWorkspaceAccess | null> => {
  const userId = String(user._id ?? user.id ?? "").trim();

  if (!userId) {
    throw new Error("User identifier is required to ensure workspace access.");
  }

  const existing = await resolveWorkspaceAccessForUser({
    tenantId,
    userId,
    session,
  });

  if (existing) return existing;

  const role = legacyRoleToWorkspaceRole(user.tenantRole);
  if (!role) return null;

  try {
    await tenantAccessRepository.createMembership(
      {
        tenant: toObjectId(tenantId),
        user: toObjectId(userId),
        status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
        role,
        customRole: null,
        locationAccess: {
          mode: LOCATION_ACCESS_MODE.ALL,
          locationIds: [],
        },
        createdBy: toObjectId(userId),
        updatedBy: toObjectId(userId),
        acceptedAt: new Date(),
      },
      { session },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  return resolveWorkspaceAccessForUser({ tenantId, userId, session });
};
