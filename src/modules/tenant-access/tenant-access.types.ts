import type { Request } from "express";
import type {
  HydratedDocument,
  InferSchemaType,
  Types,
} from "mongoose";

import type { AccessTokenUserInfo } from "@/modules/auth/auth.types.js";
import type {
  ProductTourStatus,
  ProductTourStep,
} from "@/modules/product-tour/product-tour.constants.js";
import type {
  WorkspaceGuideId,
  WorkspaceGuidePersistedStep,
  WorkspaceGuideStatus,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

import type {
  LocationAccessMode,
  TenantMembershipStatus,
  WorkspaceCalendarView,
  WorkspacePreferenceLanguage,
  WorkspaceRole,
} from "./tenant-access.constants.js";
import type { WorkspacePermission } from "./tenant-access.permissions.js";
import type { tenantCustomRoleSchema } from "./tenant-custom-role.schema.js";
import type { tenantMembershipSchema } from "./tenant-membership.schema.js";

export type TenantMembership = InferSchemaType<
  typeof tenantMembershipSchema
>;
export type TenantCustomRole = InferSchemaType<
  typeof tenantCustomRoleSchema
>;

export type TenantMembershipDocument = HydratedDocument<TenantMembership>;
export type TenantCustomRoleDocument = HydratedDocument<TenantCustomRole>;

export type WorkspaceLocationAccess = {
  mode: LocationAccessMode;
  locationIds: string[];
};

export type WorkspaceProfile = {
  jobTitle: string;
  displayName: string;
  calendarColor: string;
};

export type WorkspaceNotificationPreferences = {
  bookingAssigned: boolean;
  bookingCancelled: boolean;
  taskAssigned: boolean;
  inventoryAlerts: boolean;
  email: boolean;
  inApp: boolean;
};

export type WorkspacePreferences = {
  language: WorkspacePreferenceLanguage | null;
  displayTimezone: string | null;
  defaultLocation: string | null;
  defaultCalendarView: WorkspaceCalendarView;
  weekStartsOn: 0 | 1;
  defaultLandingPage: string;
  overviewLaunchCenterDismissed?: boolean;
  productTour?: {
    version: number;
    status: ProductTourStatus | null;
    lastStep: ProductTourStep | null;
    updatedAt: Date | null;
  };
  firstBookingCelebrationSeen?: boolean;
  contextualGuides: Partial<
    Record<
      WorkspaceGuideId,
      {
        version: number;
        status: WorkspaceGuideStatus;
        lastStep: WorkspaceGuidePersistedStep;
        updatedAt: Date | null;
      }
    >
  >;
  notifications: WorkspaceNotificationPreferences;
};

export type ResolvedWorkspaceAccess = {
  membershipId: string | null;
  tenantId: string;
  userId: string;
  status: TenantMembershipStatus;
  role: WorkspaceRole | null;
  customRoleId: string | null;
  customRoleName: string | null;
  permissions: readonly WorkspacePermission[];
  locationAccess: WorkspaceLocationAccess;
  workspaceProfile: WorkspaceProfile;
  preferences: WorkspacePreferences;
  accessVersion: number;
  isPlatformBypass: boolean;
};

export type WorkspaceAccessRequest = Request & {
  userInfo?: AccessTokenUserInfo;
  workspaceAccess?: ResolvedWorkspaceAccess | null;
  workspaceAccessResolved?: boolean;
};

export type IdLike = string | Types.ObjectId;

