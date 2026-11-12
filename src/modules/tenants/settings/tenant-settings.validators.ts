import { z } from "zod";

import {
  TENANT_WORKSPACE_INTENT_ANSWER,
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_PRICING_MODE,
  TENANT_WORKSPACE_NAVIGATION_GROUP,
  TENANT_WORKSPACE_NAVIGATION_ITEM,
} from "@/modules/tenants/tenant.constants.js";
import { MAX_TENANT_PUBLIC_LANGUAGES } from "@/modules/tenants/tenant-locale.js";
import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
  normalizeRolloutEligibleAppLocaleList,
} from "@/shared/i18n/locales.js";

const tenantLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

const tenantLocaleListSchema = z
  .array(tenantLocaleSchema)
  .max(ROLLOUT_ELIGIBLE_APP_LOCALES.length)
  .transform(normalizeRolloutEligibleAppLocaleList)
  .refine(
    (locales) => locales.length <= MAX_TENANT_PUBLIC_LANGUAGES,
    "A public site can use a primary language and one optional secondary language.",
  );

const isValidTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

export const updateTenantSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    businessType: z
      .enum([
        "coworking_space",
  "rehearsal_space",
  "community_space",
        "art_studio",
        "photography_studio",
        "wellness_studio",
        "other",
      ])
      .optional(),
    country: z.string().trim().min(1).max(80).optional(),
    /** @deprecated Compatibility alias for publicDefaultLanguage. */
    defaultLanguage: tenantLocaleSchema.optional(),
    adminLanguage: tenantLocaleSchema.optional(),
    publicDefaultLanguage: tenantLocaleSchema.optional(),
    supportedPublicLanguages: tenantLocaleListSchema.optional(),
    currency: z.enum(STUDIO_COMMERCE_CURRENCIES).optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimezone, "Enter a valid IANA timezone.")
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one workspace setting must be provided.",
  });

export type UpdateTenantSettingsInput = z.infer<
  typeof updateTenantSettingsSchema
>;

const workspaceModulesSchema = z
  .object({
    bookings: z.boolean().optional(),
    payments: z.boolean().optional(),
    customers: z.boolean().optional(),
    courses: z.boolean().optional(),
    memberships: z.boolean().optional(),
    credits: z.boolean().optional(),
    vouchers: z.boolean().optional(),
    access_codes: z.boolean().optional(),
    automations: z.boolean().optional(),
    newsletter: z.boolean().optional(),
    firing: z.literal(false).optional(),
    inventory: z.boolean().optional(),
    staff_tasks: z.boolean().optional(),
    communications: z.boolean().optional(),
    ai: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one module selection must be provided.",
  });

const completeWorkspaceModulesSchema = z
  .object({
    bookings: z.boolean(),
    payments: z.boolean(),
    customers: z.boolean(),
    courses: z.boolean(),
    memberships: z.boolean(),
    credits: z.boolean(),
    vouchers: z.boolean(),
    // Optional for the V1 workspace-intent client, which predates this module.
    // The service materializes omitted selections from server-side policy.
    access_codes: z.boolean().optional(),
    automations: z.boolean(),
    newsletter: z.boolean(),
    firing: z.literal(false).optional(),
    inventory: z.boolean(),
    staff_tasks: z.boolean(),
    communications: z.boolean(),
    ai: z.boolean(),
  })
  .strict();

const workspaceIntentAnswersSchema = z
  .object({
    [TENANT_WORKSPACE_INTENT_ANSWER.SHARED_STUDIO]: z.boolean(),
    [TENANT_WORKSPACE_INTENT_ANSWER.CLASSES]: z.boolean(),
    [TENANT_WORKSPACE_INTENT_ANSWER.FIRING_SERVICES]: z.literal(false).optional(),
    [TENANT_WORKSPACE_INTENT_ANSWER.MEMBERSHIPS]: z.boolean(),
    [TENANT_WORKSPACE_INTENT_ANSWER.VOUCHERS]: z.boolean(),
    [TENANT_WORKSPACE_INTENT_ANSWER.INVENTORY]: z.boolean(),
  })
  .strict();

const workspaceIntentSchema = z
  .object({
    definitionVersion: z.union([
      z.literal(1),
      z.literal(TENANT_WORKSPACE_INTENT_DEFINITION_VERSION),
    ]),
    // Compatibility only. Questionnaire module selections are never applied.
    modules: completeWorkspaceModulesSchema.optional(),
    pricingMode: z
      .enum(Object.values(TENANT_WORKSPACE_PRICING_MODE))
      .optional(),
    // Optional for clients and stored intents created before questionnaire
    // answers were persisted. When present, the complete map is required.
    answers: workspaceIntentAnswersSchema.optional(),
  })
  .strict();

const unique = <T extends string>(values: T[]): T[] => [...new Set(values)];

const workspaceNavigationSchema = z
  .object({
    hiddenGroups: z
      .array(z.enum(Object.values(TENANT_WORKSPACE_NAVIGATION_GROUP)))
      .max(Object.keys(TENANT_WORKSPACE_NAVIGATION_GROUP).length)
      .transform(unique)
      .optional(),
    hiddenItems: z
      .array(z.enum(Object.values(TENANT_WORKSPACE_NAVIGATION_ITEM)))
      .max(Object.keys(TENANT_WORKSPACE_NAVIGATION_ITEM).length)
      .transform(unique)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one navigation preference must be provided.",
  });

export const updateTenantWorkspaceConfigurationSchema = z
  .object({
    modules: workspaceModulesSchema.optional(),
    navigation: workspaceNavigationSchema.optional(),
    intent: workspaceIntentSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.modules !== undefined && value.intent?.modules !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["intent"],
        message:
          "Send either a partial module update or a complete workspace intent, not both.",
      });
    }
  })
  .refine(
    (value) =>
      value.modules !== undefined ||
      value.navigation !== undefined ||
      value.intent !== undefined,
    {
      message: "At least one workspace configuration change must be provided.",
    },
  );

export type UpdateTenantWorkspaceConfigurationInput = z.infer<
  typeof updateTenantWorkspaceConfigurationSchema
>;
