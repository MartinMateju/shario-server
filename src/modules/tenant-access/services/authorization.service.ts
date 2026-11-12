import type { ClientSession } from "mongoose";

import { normalizeRolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import {
  PRODUCT_TOUR_STATUS,
  PRODUCT_TOUR_STEP,
  PRODUCT_TOUR_VERSION,
} from "@/modules/product-tour/product-tour.constants.js";
import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STATUS,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

import {
  DEFAULT_WORKSPACE_CALENDAR_COLOR,
  DEFAULT_WORKSPACE_LANDING_PAGE,
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_CALENDAR_VIEW,
  WORKSPACE_ROLE,
} from "../tenant-access.constants.js";
import {
  ALL_WORKSPACE_PERMISSIONS,
  isWorkspacePermission,
  type WorkspacePermission,
} from "../tenant-access.permissions.js";
import { tenantAccessRepository } from "../tenant-access.repository.js";
import {
  getBuiltInRoleName,
  getBuiltInRolePermissions,
  isBuiltInWorkspaceRole,
} from "../tenant-access.roles.js";
import type {
  ResolvedWorkspaceAccess,
  TenantMembershipDocument,
} from "../tenant-access.types.js";

const stringId = (value: unknown): string => String(value ?? "").trim();

const normalizePermissions = (
  values: readonly unknown[],
): readonly WorkspacePermission[] => {
  return Object.freeze(
    [...new Set(values.filter(isWorkspacePermission))].sort(),
  );
};

const resolveEffectivePermissions = async (
  membership: TenantMembershipDocument,
  session?: ClientSession | null,
): Promise<{
  permissions: readonly WorkspacePermission[];
  customRoleId: string | null;
  customRoleName: string | null;
}> => {
  if (membership.role !== WORKSPACE_ROLE.CUSTOM) {
    return {
      permissions: normalizePermissions(
        getBuiltInRolePermissions(membership.role),
      ),
      customRoleId: null,
      customRoleName: null,
    };
  }

  if (!membership.customRole) {
    return {
      permissions: [],
      customRoleId: null,
      customRoleName: null,
    };
  }

  const customRole = await tenantAccessRepository.findCustomRoleById(
    membership.tenant,
    membership.customRole,
    { session },
  );

  if (!customRole?.isActive) {
    return {
      permissions: [],
      customRoleId: stringId(membership.customRole) || null,
      customRoleName: null,
    };
  }

  return {
    permissions: normalizePermissions(customRole.permissions),
    customRoleId: stringId(customRole._id),
    customRoleName: customRole.name,
  };
};

export const resolveWorkspaceAccessForUser = async ({
  tenantId,
  userId,
  session = null,
}: {
  tenantId: string;
  userId: string;
  session?: ClientSession | null;
}): Promise<ResolvedWorkspaceAccess | null> => {
  const membership = await tenantAccessRepository.findMembershipByUser(
    tenantId,
    userId,
    { session },
  );

  if (!membership) {
    return null;
  }

  const customRole = await resolveEffectivePermissions(membership, session);
  const rawLocationIds = membership.locationAccess?.locationIds ?? [];
  const rawPreferences = membership.preferences;
  const rawNotifications = rawPreferences?.notifications;
  const rawProductTour = rawPreferences?.productTour;
  const rawContextualGuides = rawPreferences?.contextualGuides;
  const rawProfile = membership.workspaceProfile;

  return {
    membershipId: stringId(membership._id),
    tenantId: stringId(membership.tenant),
    userId: stringId(membership.user),
    status: membership.status,
    role: membership.role,
    customRoleId: customRole.customRoleId,
    customRoleName: customRole.customRoleName,
    permissions:
      membership.status === TENANT_MEMBERSHIP_STATUS.ACTIVE
        ? customRole.permissions
        : [],
    locationAccess: {
      mode:
        membership.locationAccess?.mode ?? LOCATION_ACCESS_MODE.ALL,
      locationIds: rawLocationIds.map(stringId).filter(Boolean),
    },
    workspaceProfile: {
      jobTitle: rawProfile?.jobTitle ?? "",
      displayName: rawProfile?.displayName ?? "",
      calendarColor:
        rawProfile?.calendarColor ?? DEFAULT_WORKSPACE_CALENDAR_COLOR,
    },
    preferences: {
      language:
        normalizeRolloutEligibleAppLocale(rawPreferences?.language) ?? null,
      displayTimezone: rawPreferences?.displayTimezone ?? null,
      defaultLocation: stringId(rawPreferences?.defaultLocation) || null,
      defaultCalendarView:
        rawPreferences?.defaultCalendarView ?? WORKSPACE_CALENDAR_VIEW.WEEK,
      weekStartsOn: rawPreferences?.weekStartsOn === 0 ? 0 : 1,
      defaultLandingPage:
        rawPreferences?.defaultLandingPage ?? DEFAULT_WORKSPACE_LANDING_PAGE,
      overviewLaunchCenterDismissed:
        rawPreferences?.overviewLaunchCenterDismissed ?? false,
      productTour: {
        version: Math.max(0, Number(rawProductTour?.version) || 0),
        status: rawProductTour?.status ?? null,
        lastStep: rawProductTour?.lastStep ?? null,
        updatedAt: rawProductTour?.updatedAt ?? null,
      },
      firstBookingCelebrationSeen:
        rawPreferences?.firstBookingCelebrationSeen ?? false,
      contextualGuides: Object.fromEntries(
        WORKSPACE_GUIDE_IDS.flatMap((guideId) => {
          const state = rawContextualGuides?.[guideId];
          if (!state) return [];

          return [
            [
              guideId,
              {
                version: Number(state.version),
                status: state.status,
                lastStep: state.lastStep,
                updatedAt: state.updatedAt ?? null,
              },
            ],
          ];
        }),
      ),
      notifications: {
        bookingAssigned: rawNotifications?.bookingAssigned ?? true,
        bookingCancelled: rawNotifications?.bookingCancelled ?? true,
        taskAssigned: rawNotifications?.taskAssigned ?? true,
        inventoryAlerts: rawNotifications?.inventoryAlerts ?? true,
        email: rawNotifications?.email ?? true,
        inApp: rawNotifications?.inApp ?? true,
      },
    },
    accessVersion: Math.max(Number(membership.accessVersion ?? 1), 1),
    isPlatformBypass: false,
  };
};

export const createPlatformBypassAccess = ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}): ResolvedWorkspaceAccess => ({
  membershipId: null,
  tenantId,
  userId,
  status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  role: null,
  customRoleId: null,
  customRoleName: null,
  permissions: ALL_WORKSPACE_PERMISSIONS,
  locationAccess: {
    mode: LOCATION_ACCESS_MODE.ALL,
    locationIds: [],
  },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: DEFAULT_WORKSPACE_CALENDAR_COLOR,
  },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: WORKSPACE_CALENDAR_VIEW.WEEK,
    weekStartsOn: 1,
    defaultLandingPage: DEFAULT_WORKSPACE_LANDING_PAGE,
    overviewLaunchCenterDismissed: false,
    productTour: {
      version: PRODUCT_TOUR_VERSION,
      status: PRODUCT_TOUR_STATUS.COMPLETED,
      lastStep: PRODUCT_TOUR_STEP.SETTINGS,
      updatedAt: null,
    },
    firstBookingCelebrationSeen: true,
    contextualGuides: Object.fromEntries(
      WORKSPACE_GUIDE_IDS.map((guideId) => [
        guideId,
        {
          version: WORKSPACE_GUIDE_DEFINITIONS[guideId].version,
          status: WORKSPACE_GUIDE_STATUS.COMPLETED,
          lastStep: WORKSPACE_GUIDE_DEFINITIONS[guideId].terminalStep,
          updatedAt: null,
        },
      ]),
    ),
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: true,
});

export const serializeWorkspaceAccess = (
  access: ResolvedWorkspaceAccess | null | undefined,
) => {
  if (!access) return null;

  return {
    membershipId: access.membershipId,
    status: access.status,
    roleKey: access.role,
    roleName:
      access.customRoleName ??
      (isBuiltInWorkspaceRole(access.role)
        ? getBuiltInRoleName(access.role)
        : null),
    customRoleId: access.customRoleId,
    permissions: [...access.permissions],
    locationAccess: {
      mode: access.locationAccess.mode,
      locationIds: [...access.locationAccess.locationIds],
    },
    workspaceProfile: { ...access.workspaceProfile },
    preferences: {
      ...access.preferences,
      contextualGuides: Object.fromEntries(
        Object.entries(access.preferences.contextualGuides ?? {}).map(
          ([guideId, state]) => [guideId, { ...state }],
        ),
      ),
      notifications: { ...access.preferences.notifications },
    },
    authorizationVersion: access.accessVersion,
  };
};

export const hasWorkspacePermission = (
  access: ResolvedWorkspaceAccess | null | undefined,
  permission: WorkspacePermission,
): boolean => {
  return Boolean(
    access?.status === TENANT_MEMBERSHIP_STATUS.ACTIVE &&
      access.permissions.includes(permission),
  );
};

export const canAccessWorkspaceLocation = (
  access: ResolvedWorkspaceAccess | null | undefined,
  locationId: unknown,
): boolean => {
  if (!access || access.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    return false;
  }

  if (access.locationAccess.mode === LOCATION_ACCESS_MODE.ALL) {
    return true;
  }

  const normalizedLocationId = stringId(locationId);
  return Boolean(
    normalizedLocationId &&
      access.locationAccess.locationIds.includes(normalizedLocationId),
  );
};

/**
 * Returns the location ids that must be applied to a list query.
 *
 * `null` means the active membership can access every workspace location.
 * An empty array means it cannot access any location (for example, an
 * inactive membership or a selected scope with no assigned locations).
 */
export const getAllowedWorkspaceLocationIds = (
  access: ResolvedWorkspaceAccess | null | undefined,
): readonly string[] | null => {
  if (!access || access.status !== TENANT_MEMBERSHIP_STATUS.ACTIVE) {
    return [];
  }

  if (access.locationAccess.mode === LOCATION_ACCESS_MODE.ALL) {
    return null;
  }

  return Object.freeze(
    [...new Set(access.locationAccess.locationIds.map(stringId).filter(Boolean))],
  );
};

