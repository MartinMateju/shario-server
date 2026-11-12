import mongoose, { Schema } from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";
import {
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
  normalizeRolloutEligibleAppLocaleList,
} from "@/shared/i18n/locales.js";

import {
  DEFAULT_TENANT_CURRENCY,
  DEFAULT_TENANT_TIMEZONE,
  TENANT_DOMAIN_STATUS,
  TENANT_DOMAIN_TYPE,
  TENANT_LANGUAGES,
  TENANT_MODULE,
  TENANT_PLAN,
  TENANT_STATUS,
  TENANT_WORKSPACE_INTENT_ANSWER,
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_SOURCE,
  TENANT_WORKSPACE_PRICING_MODE,
  TENANT_WORKSPACE_NAVIGATION_GROUP,
  TENANT_WORKSPACE_NAVIGATION_ITEM,
} from "./tenant.constants.js";
import { tenantOnboardingSchema } from "./onboarding/tenant-onboarding.schema.js";
import { getCurrentPlanVersion, getPlanConfig } from "./tenant.plan.js";
import {
  DEFAULT_TENANT_LOCALE,
  LEGACY_TENANT_LANGUAGE,
  MAX_TENANT_PUBLIC_LANGUAGES,
  normalizeTenantPublicLanguageSelection,
  toLegacyTenantLanguage,
} from "./tenant-locale.js";
import {
  tenantPublicSiteEditorSchema,
  tenantPublicSiteSchema,
} from "./public-site/tenant-public-site.schema.js";

import type {
  Tenant,
  TenantDomain,
  TenantModel as TenantMongooseModel,
  TenantWorkspaceIntentAnswers,
  TenantWorkspaceModules,
  TenantWorkspaceNavigation,
} from "./tenant.types.js";

const tenantDomainSchema =
  new Schema<TenantDomain>(
    {
      hostname: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        maxlength: 253,
      },

      type: {
        type: String,
        enum: Object.values(
          TENANT_DOMAIN_TYPE,
        ),
        default:
          TENANT_DOMAIN_TYPE.SUBDOMAIN,
      },

      status: {
        type: String,
        enum: Object.values(
          TENANT_DOMAIN_STATUS,
        ),
        default:
          TENANT_DOMAIN_STATUS.ACTIVE,
      },

      isPrimary: {
        type: Boolean,
        default: false,
      },
    },
    {
      _id: false,
    },
  );

const tenantWorkspaceModuleStateSchema = new Schema(
  {
    selected: {
      type: Boolean,
      required: true,
    },
    enabledAt: Date,
    disabledAt: Date,
    lastUsedAt: Date,
  },
  { _id: false },
);

const workspaceModule = () => ({
  type: tenantWorkspaceModuleStateSchema,
  default: undefined,
});

const tenantWorkspaceModulesSchema = new Schema<TenantWorkspaceModules>(
  {
    [TENANT_MODULE.BOOKINGS]: workspaceModule(),
    [TENANT_MODULE.PAYMENTS]: workspaceModule(),
    [TENANT_MODULE.CUSTOMERS]: workspaceModule(),
    [TENANT_MODULE.COURSES]: workspaceModule(),
    [TENANT_MODULE.MEMBERSHIPS]: workspaceModule(),
    [TENANT_MODULE.CREDITS]: workspaceModule(),
    [TENANT_MODULE.VOUCHERS]: workspaceModule(),
    [TENANT_MODULE.ACCESS_CODES]: workspaceModule(),
    [TENANT_MODULE.AUTOMATIONS]: workspaceModule(),
    [TENANT_MODULE.NEWSLETTER]: workspaceModule(),
    [TENANT_MODULE.FIRING]: workspaceModule(),
    [TENANT_MODULE.INVENTORY]: workspaceModule(),
    [TENANT_MODULE.STAFF_TASKS]: workspaceModule(),
    [TENANT_MODULE.COMMUNICATIONS]: workspaceModule(),
    [TENANT_MODULE.AI]: workspaceModule(),
  },
  { _id: false },
);

const tenantWorkspaceIntentAnswersSchema =
  new Schema<TenantWorkspaceIntentAnswers>(
    {
      [TENANT_WORKSPACE_INTENT_ANSWER.SHARED_STUDIO]: {
        type: Boolean,
        required: true,
      },
      [TENANT_WORKSPACE_INTENT_ANSWER.CLASSES]: {
        type: Boolean,
        required: true,
      },
      [TENANT_WORKSPACE_INTENT_ANSWER.FIRING_SERVICES]: {
        type: Boolean,
      },
      [TENANT_WORKSPACE_INTENT_ANSWER.MEMBERSHIPS]: {
        type: Boolean,
        required: true,
      },
      [TENANT_WORKSPACE_INTENT_ANSWER.VOUCHERS]: {
        type: Boolean,
        required: true,
      },
      [TENANT_WORKSPACE_INTENT_ANSWER.INVENTORY]: {
        type: Boolean,
        required: true,
      },
    },
    { _id: false },
  );

const tenantWorkspaceIntentSchema = new Schema(
  {
    definitionVersion: {
      type: Number,
      required: true,
      min: 1,
      default: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
    },
    answers: {
      type: tenantWorkspaceIntentAnswersSchema,
      default: undefined,
      validate: {
        validator: (value: unknown) => value !== null,
        message: "Workspace intent answers must be a complete answer map.",
      },
    },
    pricingMode: {
      type: String,
      enum: Object.values(TENANT_WORKSPACE_PRICING_MODE),
      default: undefined,
    },
    confirmedAt: { type: Date, required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    source: {
      type: String,
      enum: Object.values(TENANT_WORKSPACE_INTENT_SOURCE),
      required: true,
      default: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
    },
  },
  { _id: false },
);

const tenantWorkspaceNavigationSchema = new Schema<TenantWorkspaceNavigation>(
  {
    hiddenGroups: {
      type: [String],
      enum: Object.values(TENANT_WORKSPACE_NAVIGATION_GROUP),
      default: [],
    },
    hiddenItems: {
      type: [String],
      enum: Object.values(TENANT_WORKSPACE_NAVIGATION_ITEM),
      default: [],
    },
  },
  { _id: false },
);

const canonicalLocaleSetter = (value: unknown): unknown =>
  normalizeRolloutEligibleAppLocale(value) ?? value;

const canonicalLocaleListSetter = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;

  return [
    ...new Set(
      value.map(
        (locale) => normalizeRolloutEligibleAppLocale(locale) ?? locale,
      ),
    ),
  ];
};

const starterPlan = getPlanConfig(
  TENANT_PLAN.STARTER,
);

export const tenantSchema = new Schema<
  Tenant,
  TenantMongooseModel
>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 120,
    },

    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 2,
      maxlength: 80,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },

    status: {
      type: String,
      enum: Object.values(TENANT_STATUS),
      default: TENANT_STATUS.ACTIVE,
    },

    plan: {
      type: String,
      enum: Object.values(TENANT_PLAN),
      default: TENANT_PLAN.STARTER,
    },

    voucherQuotaVersion: { type: Number, enum: [1], default: undefined },

    planVersion: {
      type: Number,
      required: true,
      min: 1,
      default: () => getCurrentPlanVersion(TENANT_PLAN.STARTER),
    },

    /**
     * Monotonic tenant-scoped authorization write lock/version.
     * Membership and custom-role transactions increment this before checking
     * owner invariants or plan seat limits.
     */
    accessControlVersion: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    domains: {
      type: [tenantDomainSchema],
      default: [],
    },

    modules: {
      [TENANT_MODULE.BOOKINGS]: {
        type: Boolean,
        default:
          starterPlan.modules.bookings,
      },

      [TENANT_MODULE.PAYMENTS]: {
        type: Boolean,
        default:
          starterPlan.modules.payments,
      },

      [TENANT_MODULE.CUSTOMERS]: {
        type: Boolean,
        default:
          starterPlan.modules.customers,
      },

      [TENANT_MODULE.COURSES]: {
        type: Boolean,
        default:
          starterPlan.modules.courses,
      },

      [TENANT_MODULE.MEMBERSHIPS]: {
        type: Boolean,
        default:
          starterPlan.modules.memberships,
      },

      [TENANT_MODULE.CREDITS]: {
        type: Boolean,
        default:
          starterPlan.modules.credits,
      },

      [TENANT_MODULE.VOUCHERS]: {
        type: Boolean,
        default:
          starterPlan.modules.vouchers,
      },

      [TENANT_MODULE.ACCESS_CODES]: {
        type: Boolean,
      },

      [TENANT_MODULE.AUTOMATIONS]: {
        type: Boolean,
        default:
          starterPlan.modules.automations,
      },

      [TENANT_MODULE.NEWSLETTER]: {
        type: Boolean,
        default:
          starterPlan.modules.newsletter,
      },

      [TENANT_MODULE.FIRING]: {
        type: Boolean,
        default:
          starterPlan.modules.firing,
      },

      [TENANT_MODULE.INVENTORY]: {
        type: Boolean,
        default:
          starterPlan.modules.inventory,
      },

      [TENANT_MODULE.STAFF_TASKS]: {
        type: Boolean,
        default:
          starterPlan.modules.staff_tasks,
      },

      [TENANT_MODULE.COMMUNICATIONS]: {
        type: Boolean,
        default:
          starterPlan.modules.communications,
      },

      [TENANT_MODULE.AI]: {
        type: Boolean,
        default:
          starterPlan.modules.ai,
      },
    },

    workspaceModules: {
      type: tenantWorkspaceModulesSchema,
      default: () => ({}),
    },

    workspaceIntent: {
      type: tenantWorkspaceIntentSchema,
      default: undefined,
    },

    limits: {
      locations: {
        type: Number,
        default:
          starterPlan.limits.locations,
        min: 1,
      },

      admins: {
        type: Number,
        default:
          starterPlan.limits.admins,
        min: 1,
      },

      staffMembers: {
        type: Number,
        default:
          starterPlan.limits.staffMembers,
        min: 1,
      },

      inventoryItems: {
        type: Number,
        default:
          starterPlan.limits.inventoryItems,
        min: 0,
      },

      monthlyEmails: {
        type: Number,
        default:
          starterPlan.limits.monthlyEmails,
        min: 0,
      },

      monthlyAutomations: {
        type: Number,
        default:
          starterPlan.limits.monthlyAutomations,
        min: 0,
      },

      aiCredits: {
        type: Number,
        default:
          starterPlan.limits.aiCredits,
        min: 0,
      },
    },

    settings: {
      defaultLanguage: {
        type: String,
        enum: TENANT_LANGUAGES,
        set: (value: unknown) => toLegacyTenantLanguage(value) ?? value,
        default: LEGACY_TENANT_LANGUAGE.EN,
      },

      adminLanguage: {
        type: String,
        enum: ROLLOUT_ELIGIBLE_APP_LOCALES,
        set: canonicalLocaleSetter,
      },

      publicDefaultLanguage: {
        type: String,
        enum: ROLLOUT_ELIGIBLE_APP_LOCALES,
        set: canonicalLocaleSetter,
      },

      supportedPublicLanguages: {
        type: [String],
        enum: ROLLOUT_ELIGIBLE_APP_LOCALES,
        set: canonicalLocaleListSetter,
        default: undefined,
        validate: {
          validator(
            this: {
              isNew?: boolean;
              isModified?: (path: string) => boolean;
            },
            value: unknown,
          ) {
            if (!Array.isArray(value)) return true;

            const contractIsBeingWritten =
              this.isNew === true ||
              typeof this.isModified !== "function" ||
              this.isModified("settings.publicDefaultLanguage") ||
              this.isModified("settings.supportedPublicLanguages");

            return (
              !contractIsBeingWritten ||
              value.length <= MAX_TENANT_PUBLIC_LANGUAGES
            );
          },
          message:
            "A public site can use a primary language and one optional secondary language.",
        },
      },

      currency: {
        type: String,
        enum: STUDIO_COMMERCE_CURRENCIES,
        trim: true,
        uppercase: true,
        default:
          DEFAULT_TENANT_CURRENCY,
        minlength: 3,
        maxlength: 3,
      },

      timezone: {
        type: String,
        trim: true,
        default:
          DEFAULT_TENANT_TIMEZONE,
        maxlength: 100,
      },

      navigation: {
        type: tenantWorkspaceNavigationSchema,
        default: () => ({ hiddenGroups: [], hiddenItems: [] }),
      },
    },

    publicSite: {
      type: tenantPublicSiteSchema,
      default: () => ({}),
    },

    publicSiteEditor: {
      type: tenantPublicSiteEditorSchema,
      default: undefined,
    },

    onboarding: {
      type: tenantOnboardingSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

/*
|--------------------------------------------------------------------------
| Indexes
|--------------------------------------------------------------------------
*/

tenantSchema.index(
  {
    slug: 1,
  },
  {
    unique: true,
  },
);

tenantSchema.index({
  status: 1,
  plan: 1,
});

tenantSchema.index(
  {
    "domains.hostname": 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      "domains.hostname": {
        $exists: true,
        $type: "string",
      },
    },
  },
);

/*
|--------------------------------------------------------------------------
| Normalization
|--------------------------------------------------------------------------
*/

tenantSchema.pre(
  "validate",
  function normalizeTenant() {
    const settings = this.settings;
    const persistedLegacyLanguage = settings.defaultLanguage;
    const rawSupported = settings.supportedPublicLanguages ?? [];
    const shouldNormalizeSupportedPublicLanguages =
      this.isNew ||
      this.isModified("settings.publicDefaultLanguage") ||
      this.isModified("settings.supportedPublicLanguages") ||
      settings.publicDefaultLanguage === undefined ||
      settings.supportedPublicLanguages === undefined ||
      rawSupported.length === 0;
    const legacyLanguage = toLegacyTenantLanguage(persistedLegacyLanguage);
    const legacyDefault =
      normalizeRolloutEligibleAppLocale(settings.defaultLanguage) ??
      DEFAULT_TENANT_LOCALE;
    const adminLanguage = normalizeRolloutEligibleAppLocale(
      settings.adminLanguage,
    );
    const publicDefaultLanguage = normalizeRolloutEligibleAppLocale(
      settings.publicDefaultLanguage,
    );

    settings.adminLanguage =
      adminLanguage ?? settings.adminLanguage ?? legacyDefault;
    settings.publicDefaultLanguage =
      publicDefaultLanguage ??
      settings.publicDefaultLanguage ??
      legacyDefault;

    const supportedPublicLanguages = rawSupported.length
      ? [
          ...new Set(
            rawSupported.map(
              (locale) => normalizeRolloutEligibleAppLocale(locale) ?? locale,
            ),
          ),
        ]
      : [publicDefaultLanguage ?? legacyDefault];

    const canonicalPublicDefault = normalizeRolloutEligibleAppLocale(
      settings.publicDefaultLanguage,
    );
    const legacyValueWasUnknown = Boolean(
      String(persistedLegacyLanguage ?? "").trim() && !legacyLanguage,
    );
    settings.defaultLanguage = legacyValueWasUnknown
      ? persistedLegacyLanguage
      : toLegacyTenantLanguage(canonicalPublicDefault ?? legacyDefault) ??
        LEGACY_TENANT_LANGUAGE.EN;
    const canonicalSupported = normalizeRolloutEligibleAppLocaleList(
      supportedPublicLanguages,
    );
    const everySupportedLanguageIsCanonical =
      canonicalSupported.length === supportedPublicLanguages.length;
    if (shouldNormalizeSupportedPublicLanguages) {
      settings.supportedPublicLanguages =
        canonicalPublicDefault && everySupportedLanguageIsCanonical
          ? normalizeTenantPublicLanguageSelection({
              publicDefaultLanguage: canonicalPublicDefault,
              supportedPublicLanguages: canonicalSupported,
            })
          : supportedPublicLanguages;
    }

    if (this.slug) {
      this.slug = this.slug
        .toLowerCase()
        .trim();
    }

    this.domains?.forEach((domain) => {
      if (domain.hostname) {
        domain.hostname =
          domain.hostname
            .toLowerCase()
            .trim();
      }
    });
  },
);

/*
|--------------------------------------------------------------------------
| Model
|--------------------------------------------------------------------------
*/

export const TenantModel =
  (mongoose.models
    .Tenant as TenantMongooseModel | undefined) ??
  mongoose.model<
    Tenant,
    TenantMongooseModel
  >(
    "Tenant",
    tenantSchema,
  );

export default TenantModel;
