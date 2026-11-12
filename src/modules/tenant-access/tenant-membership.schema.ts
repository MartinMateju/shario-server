import mongoose, { Schema } from "mongoose";

import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  PRODUCT_TOUR_STATUSES,
  PRODUCT_TOUR_STEPS,
} from "@/modules/product-tour/product-tour.constants.js";
import {
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STATUS,
  WORKSPACE_GUIDE_STATUSES,
  getWorkspaceGuideDefinitionForVersion,
} from "@/modules/workspace-guides/workspace-guide.constants.js";

import {
  DEFAULT_WORKSPACE_CALENDAR_COLOR,
  DEFAULT_WORKSPACE_LANDING_PAGE,
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_CALENDAR_VIEW,
  WORKSPACE_ROLE,
} from "./tenant-access.constants.js";

const workspaceProfileSchema = new Schema(
  {
    jobTitle: {
      type: String,
      trim: true,
      default: "",
      maxlength: 120,
    },
    displayName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },
    calendarColor: {
      type: String,
      trim: true,
      default: DEFAULT_WORKSPACE_CALENDAR_COLOR,
      match: /^#(?:[0-9a-fA-F]{3}){1,2}$/,
    },
  },
  { _id: false },
);

const workspaceNotificationPreferencesSchema = new Schema(
  {
    bookingAssigned: { type: Boolean, default: true },
    bookingCancelled: { type: Boolean, default: true },
    taskAssigned: { type: Boolean, default: true },
    inventoryAlerts: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
  },
  { _id: false },
);

const workspaceProductTourPreferencesSchema = new Schema(
  {
    version: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: [...PRODUCT_TOUR_STATUSES, null],
      default: null,
    },
    lastStep: {
      type: String,
      enum: [...PRODUCT_TOUR_STEPS, null],
      default: null,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const workspaceContextualGuidePreferenceSchema = new Schema(
  {
    version: { type: Number, min: 1, required: true },
    status: {
      type: String,
      enum: WORKSPACE_GUIDE_STATUSES,
      required: true,
    },
    lastStep: { type: String, required: true, trim: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false, strict: true },
);

const workspaceContextualGuidesSchema = new Schema(
  Object.fromEntries(
    WORKSPACE_GUIDE_IDS.map((guideId) => [
      guideId,
      {
        type: workspaceContextualGuidePreferenceSchema,
        default: undefined,
        validate: {
          validator(
            value: {
              version?: number;
              status?: string;
              lastStep?: string;
            } | null,
          ) {
            if (!value) return true;

            const definition = getWorkspaceGuideDefinitionForVersion(
              guideId,
              value.version,
            );
            const lastStep = String(value.lastStep ?? "");

            return Boolean(
              definition &&
                definition.steps.includes(lastStep) &&
                (value.status !== WORKSPACE_GUIDE_STATUS.COMPLETED ||
                  lastStep === definition.terminalStep),
            );
          },
          message: `Invalid contextual guide state for ${guideId}.`,
        },
      },
    ]),
  ),
  { _id: false, strict: true },
);

const workspacePreferencesSchema = new Schema(
  {
    language: {
      type: String,
      enum: [...ROLLOUT_ELIGIBLE_APP_LOCALES, null],
      set: (value: unknown) =>
        value === null
          ? null
          : normalizeRolloutEligibleAppLocale(value) ?? value,
      default: null,
    },
    displayTimezone: {
      type: String,
      trim: true,
      default: null,
      maxlength: 100,
    },
    defaultLocation: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      default: null,
    },
    defaultCalendarView: {
      type: String,
      enum: Object.values(WORKSPACE_CALENDAR_VIEW),
      default: WORKSPACE_CALENDAR_VIEW.WEEK,
    },
    weekStartsOn: {
      type: Number,
      enum: [0, 1],
      default: 1,
    },
    defaultLandingPage: {
      type: String,
      trim: true,
      default: DEFAULT_WORKSPACE_LANDING_PAGE,
      maxlength: 160,
    },
    overviewLaunchCenterDismissed: {
      type: Boolean,
      default: false,
    },
    productTour: {
      type: workspaceProductTourPreferencesSchema,
      default: () => ({}),
    },
    firstBookingCelebrationSeen: {
      type: Boolean,
      default: false,
    },
    contextualGuides: {
      type: workspaceContextualGuidesSchema,
      default: () => ({}),
    },
    notifications: {
      type: workspaceNotificationPreferencesSchema,
      default: () => ({}),
    },
  },
  { _id: false },
);

const locationAccessSchema = new Schema(
  {
    mode: {
      type: String,
      enum: Object.values(LOCATION_ACCESS_MODE),
      default: LOCATION_ACCESS_MODE.ALL,
    },
    locationIds: {
      type: [Schema.Types.ObjectId],
      ref: "Location",
      default: [],
    },
  },
  { _id: false },
);

export const tenantMembershipSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(TENANT_MEMBERSHIP_STATUS),
      default: TENANT_MEMBERSHIP_STATUS.ACTIVE,
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: Object.values(WORKSPACE_ROLE),
      required: true,
      index: true,
    },
    customRole: {
      type: Schema.Types.ObjectId,
      ref: "TenantCustomRole",
      default: null,
      index: true,
    },
    locationAccess: {
      type: locationAccessSchema,
      default: () => ({}),
    },
    workspaceProfile: {
      type: workspaceProfileSchema,
      default: () => ({}),
    },
    preferences: {
      type: workspacePreferencesSchema,
      default: () => ({}),
    },
    accessVersion: {
      type: Number,
      min: 1,
      default: 1,
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

tenantMembershipSchema.index(
  { tenant: 1, user: 1 },
  {
    unique: true,
    name: "tenant_1_user_1",
  },
);

tenantMembershipSchema.index(
  { tenant: 1, status: 1, role: 1 },
  { name: "tenant_1_status_1_role_1" },
);

tenantMembershipSchema.index(
  { tenant: 1, "locationAccess.locationIds": 1, status: 1 },
  { name: "tenant_1_locationAccess_1_status_1" },
);

tenantMembershipSchema.pre("validate", function normalizeMembership() {
  if (this.preferences.language !== null) {
    const canonicalLanguage = normalizeRolloutEligibleAppLocale(
      this.preferences.language,
    );
    if (canonicalLanguage) this.preferences.language = canonicalLanguage;
  }

  if (this.role === WORKSPACE_ROLE.CUSTOM && !this.customRole) {
    this.invalidate(
      "customRole",
      "A custom role reference is required for a custom membership.",
    );
  }

  if (this.role !== WORKSPACE_ROLE.CUSTOM) {
    this.customRole = null;
  }

  if (this.role === WORKSPACE_ROLE.OWNER) {
    this.locationAccess.mode = LOCATION_ACCESS_MODE.ALL;
    this.locationAccess.locationIds = [];
  }

  if (this.locationAccess.mode === LOCATION_ACCESS_MODE.ALL) {
    this.locationAccess.locationIds = [];
  }

  const uniqueLocationIds = new Map(
    this.locationAccess.locationIds.map((id) => [String(id), id]),
  );
  this.locationAccess.locationIds = [...uniqueLocationIds.values()];
});


