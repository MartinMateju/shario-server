import mongoose from "mongoose";
import { z } from "zod";

import {
  PRODUCT_TOUR_STATUS,
  PRODUCT_TOUR_STATUSES,
  PRODUCT_TOUR_STEP,
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_VERSION,
} from "@/modules/product-tour/product-tour.constants.js";
import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STATUS,
  WORKSPACE_GUIDE_STATUSES,
} from "@/modules/workspace-guides/workspace-guide.constants.js";
import { badRequest } from "@/shared/http/httpErrors.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  DEFAULT_TEAM_PAGE_SIZE,
  DEFAULT_WORKSPACE_CALENDAR_COLOR,
  DEFAULT_WORKSPACE_LANDING_PAGE,
  LOCATION_ACCESS_MODE,
  MAX_TEAM_PAGE_SIZE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_CALENDAR_VIEW,
  WORKSPACE_ROLE,
} from "./tenant-access.constants.js";
import { ALL_WORKSPACE_PERMISSIONS } from "./tenant-access.permissions.js";

const objectIdSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${label}.`,
    });

const nullableObjectIdSchema = (label: string) =>
  z.union([objectIdSchema(label), z.null()]);

const timezoneSchema = z
  .string()
  .trim()
  .max(100)
  .refine(
    (timezone) => {
      try {
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
        }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone." },
  );

export const locationAccessInputSchema = z
  .object({
    mode: z.enum(Object.values(LOCATION_ACCESS_MODE)),
    locationIds: z.array(objectIdSchema("location id")).max(100).default([]),
  })
  .strict()
  .transform((value) => ({
    mode: value.mode,
    locationIds:
      value.mode === LOCATION_ACCESS_MODE.ALL
        ? []
        : [...new Set(value.locationIds)],
  }));

export const workspaceProfileInputSchema = z
  .object({
    jobTitle: z.string().trim().max(120).optional(),
    displayName: z.string().trim().max(160).optional(),
    calendarColor: z
      .string()
      .trim()
      .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, "Invalid HEX colour.")
      .default(DEFAULT_WORKSPACE_CALENDAR_COLOR)
      .optional(),
  })
  .strict();

const productTourPreferencesInputSchema = z
  .object({
    version: z.literal(PRODUCT_TOUR_VERSION),
    status: z.enum(PRODUCT_TOUR_STATUSES),
    lastStep: z.enum(PRODUCT_TOUR_STEPS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === PRODUCT_TOUR_STATUS.COMPLETED &&
      value.lastStep !== PRODUCT_TOUR_STEP.SETTINGS
    ) {
      context.addIssue({
        code: "custom",
        path: ["lastStep"],
        message: "A completed product tour must finish on the settings step.",
      });
    }
  });

const contextualGuideStateInputSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(WORKSPACE_GUIDE_STATUSES),
    lastStep: z.string().trim().min(1).max(80),
  })
  .strict();

const contextualGuidesInputSchema = z
  .partialRecord(z.enum(WORKSPACE_GUIDE_IDS), contextualGuideStateInputSchema)
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one contextual guide state must be provided.",
  })
  .superRefine((value, context) => {
    for (const [guideId, state] of Object.entries(value)) {
      if (!state) continue;

      const definition =
        WORKSPACE_GUIDE_DEFINITIONS[
          guideId as keyof typeof WORKSPACE_GUIDE_DEFINITIONS
        ];
      if (!definition) continue;

      if (state.version !== definition.version) {
        context.addIssue({
          code: "custom",
          path: [guideId, "version"],
          message: "The contextual guide version is not current.",
        });
      }

      if (!(definition.steps as readonly string[]).includes(state.lastStep)) {
        context.addIssue({
          code: "custom",
          path: [guideId, "lastStep"],
          message: "The contextual guide step is not registered.",
        });
      }

      if (
        state.status === WORKSPACE_GUIDE_STATUS.COMPLETED &&
        state.lastStep !== definition.terminalStep
      ) {
        context.addIssue({
          code: "custom",
          path: [guideId, "lastStep"],
          message: "A completed contextual guide must finish on its terminal step.",
        });
      }
    }
  });

const workspaceLanguageSchema = z.preprocess(
  (value) =>
    value === null ? null : normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES).nullable(),
);

const notificationsInputSchema = z
  .object({
    bookingAssigned: z.boolean().optional(),
    bookingCancelled: z.boolean().optional(),
    taskAssigned: z.boolean().optional(),
    inventoryAlerts: z.boolean().optional(),
    email: z.boolean().optional(),
    inApp: z.boolean().optional(),
  })
  .strict();

export const workspacePreferencesInputSchema = z
  .object({
    language: workspaceLanguageSchema.optional(),
    displayTimezone: timezoneSchema.nullable().optional(),
    defaultLocation: nullableObjectIdSchema("default location id").optional(),
    defaultCalendarView: z
      .enum(Object.values(WORKSPACE_CALENDAR_VIEW))
      .optional(),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
    defaultLandingPage: z
      .string()
      .trim()
      .min(4)
      .max(160)
      .refine(
        (value) =>
          value === DEFAULT_WORKSPACE_LANDING_PAGE ||
          value.startsWith(`${DEFAULT_WORKSPACE_LANDING_PAGE}/`),
        {
          message: "Default landing page must be inside /app.",
        },
      )
      .optional(),
    overviewLaunchCenterDismissed: z.boolean().optional(),
    productTour: productTourPreferencesInputSchema.optional(),
    firstBookingCelebrationSeen: z.boolean().optional(),
    contextualGuides: contextualGuidesInputSchema.optional(),
    notifications: notificationsInputSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one workspace preference must be provided.",
  });

const roleSchema = z.enum(Object.values(WORKSPACE_ROLE));

export const createTeamMemberBaseSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    roleKey: roleSchema.optional(),
    role: roleSchema.optional(),
    customRoleId: nullableObjectIdSchema("custom role id").optional(),
    locationAccess: locationAccessInputSchema.default({
      mode: LOCATION_ACCESS_MODE.ALL,
      locationIds: [],
    }),
    workspaceProfile: workspaceProfileInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.roleKey && !value.role) {
      context.addIssue({
        code: "custom",
        path: ["roleKey"],
        message: "Role key is required.",
      });
    }

    if (value.roleKey && value.role && value.roleKey !== value.role) {
      context.addIssue({
        code: "custom",
        path: ["roleKey"],
        message: "roleKey and legacy role must match when both are provided.",
      });
    }

    const roleKey = value.roleKey ?? value.role;

    if (roleKey === WORKSPACE_ROLE.CUSTOM && !value.customRoleId) {
      context.addIssue({
        code: "custom",
        path: ["customRoleId"],
        message: "Custom role id is required for a custom membership.",
      });
    }

    if (roleKey !== WORKSPACE_ROLE.CUSTOM && value.customRoleId) {
      context.addIssue({
        code: "custom",
        path: ["customRoleId"],
        message: "Custom role id is only valid for a custom membership.",
      });
    }
  });

export const createTeamMemberSchema = createTeamMemberBaseSchema.transform(
  ({ role, roleKey, ...value }) => ({
    ...value,
    roleKey: roleKey ?? role!,
  }),
);

export const updateTeamMemberSchema = z
  .object({
    roleKey: roleSchema.optional(),
    role: roleSchema.optional(),
    customRoleId: nullableObjectIdSchema("custom role id").optional(),
    status: z
      .enum([
        TENANT_MEMBERSHIP_STATUS.ACTIVE,
        TENANT_MEMBERSHIP_STATUS.SUSPENDED,
      ])
      .optional(),
    locationAccess: locationAccessInputSchema.optional(),
    workspaceProfile: workspaceProfileInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one team member field must be provided.",
      });
    }

    if (value.roleKey && value.role && value.roleKey !== value.role) {
      context.addIssue({
        code: "custom",
        path: ["roleKey"],
        message: "roleKey and legacy role must match when both are provided.",
      });
    }
  })
  .transform(({ role, roleKey, ...value }) => ({
    ...value,
    ...(roleKey || role ? { roleKey: roleKey ?? role } : {}),
  }));

export const listTeamMembersSchema = z
  .object({
    status: z.enum(Object.values(TENANT_MEMBERSHIP_STATUS)).optional(),
    role: roleSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_TEAM_PAGE_SIZE)
      .default(DEFAULT_TEAM_PAGE_SIZE),
  })
  .strict();

export const membershipIdParamsSchema = z.object({
  membershipId: objectIdSchema("membership id"),
});

const permissionSchema = z.enum(
  ALL_WORKSPACE_PERMISSIONS as [string, ...string[]],
);

export const createCustomRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).default(""),
    permissions: z.array(permissionSchema).max(100).default([]),
  })
  .strict()
  .transform((value) => ({
    ...value,
    permissions: [...new Set(value.permissions)].sort(),
  }));

export const updateCustomRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z.array(permissionSchema).max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one role field must be provided.",
  })
  .transform((value) => ({
    ...value,
    ...(value.permissions
      ? { permissions: [...new Set(value.permissions)].sort() }
      : {}),
  }));

export const roleIdParamsSchema = z.object({
  roleId: objectIdSchema("role id"),
});

export type CreateTeamMemberInput = z.infer<typeof createTeamMemberSchema>;
export type UpdateTeamMemberInput = z.infer<typeof updateTeamMemberSchema>;
export type ListTeamMembersInput = z.infer<typeof listTeamMembersSchema>;
export type WorkspacePreferencesInput = z.infer<
  typeof workspacePreferencesInputSchema
>;
export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;
export type UpdateCustomRoleInput = z.infer<typeof updateCustomRoleSchema>;

export const parseTenantAccessInput = <T>(
  schema: z.ZodType<T>,
  input: unknown,
): T => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    badRequest({
      message: "Invalid tenant access request.",
      code: "TENANT_ACCESS_VALIDATION_FAILED",
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
};

