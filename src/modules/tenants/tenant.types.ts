import type { HydratedDocument, Model, Types } from "mongoose";
import type { Request } from "express";
import type { PortalAppearance } from "@/shared/appearance/portal-appearance.js";
import type { RolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import type {
  TENANT_DOMAIN_STATUS,
  TENANT_DOMAIN_TYPE,
  TENANT_LANGUAGE,
  TENANT_MODULE,
  TENANT_PLAN,
  TENANT_STATUS,
  TENANT_WORKSPACE_INTENT_ANSWER,
  TENANT_WORKSPACE_INTENT_SOURCE,
  TENANT_WORKSPACE_PRICING_MODE,
  TENANT_WORKSPACE_NAVIGATION_GROUP,
  TENANT_WORKSPACE_NAVIGATION_ITEM,
} from "./tenant.constants.js";
import type {
  TenantStoredBookingType,
  TenantBusinessType,
  TenantConfirmationMode,
  TenantTeamSize,
} from "./onboarding/tenant-onboarding.constants.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import type {
  CustomerPortalNavigationKey,
  CustomerPortalPageId,
  PublicSiteFontPreset,
  PublicSiteHomeSection,
  PublicSiteNavItem,
  PublicSitePrimaryCta,
  PublicSiteStylePreset,
} from "./public-site/tenant-public-site.constants.js";

export type TenantId = string | Types.ObjectId;
export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS];
export type TenantPlan = (typeof TENANT_PLAN)[keyof typeof TENANT_PLAN];
export type TenantDomainType =
  (typeof TENANT_DOMAIN_TYPE)[keyof typeof TENANT_DOMAIN_TYPE];
export type TenantDomainStatus =
  (typeof TENANT_DOMAIN_STATUS)[keyof typeof TENANT_DOMAIN_STATUS];
export type TenantLanguage =
  (typeof TENANT_LANGUAGE)[keyof typeof TENANT_LANGUAGE];
export type TenantModuleName =
  (typeof TENANT_MODULE)[keyof typeof TENANT_MODULE];
export type TenantWorkspaceNavigationGroup =
  (typeof TENANT_WORKSPACE_NAVIGATION_GROUP)[keyof typeof TENANT_WORKSPACE_NAVIGATION_GROUP];
export type TenantWorkspaceNavigationItem =
  (typeof TENANT_WORKSPACE_NAVIGATION_ITEM)[keyof typeof TENANT_WORKSPACE_NAVIGATION_ITEM];

/**
 * Access Codes were introduced as an explicit module in Plan V3. Historical
 * V1/V2 snapshots intentionally omit the key and use a compatibility policy
 * when effective entitlements are derived.
 */
export type TenantModules = Omit<
  Record<TenantModuleName, boolean>,
  "access_codes"
> & {
  access_codes?: boolean;
};

export type TenantWorkspaceModuleState = {
  selected: boolean;
  enabledAt?: Date;
  disabledAt?: Date;
  lastUsedAt?: Date;
};

export type TenantWorkspaceModules = Partial<
  Record<TenantModuleName, TenantWorkspaceModuleState>
>;

export type TenantWorkspaceIntentSource =
  (typeof TENANT_WORKSPACE_INTENT_SOURCE)[keyof typeof TENANT_WORKSPACE_INTENT_SOURCE];

export type TenantWorkspaceIntentAnswer =
  (typeof TENANT_WORKSPACE_INTENT_ANSWER)[keyof typeof TENANT_WORKSPACE_INTENT_ANSWER];

export type TenantWorkspaceIntentAnswers = Record<
  Exclude<TenantWorkspaceIntentAnswer, "firingServices">,
  boolean
> & { firingServices?: boolean };

export type TenantWorkspacePricingMode =
  (typeof TENANT_WORKSPACE_PRICING_MODE)[keyof typeof TENANT_WORKSPACE_PRICING_MODE];

export type TenantWorkspaceIntent = {
  definitionVersion: number;
  /** Missing on workspace intents saved before questionnaire answers were persisted. */
  answers?: TenantWorkspaceIntentAnswers;
  /** Controls customer My work access; never changes staff modules or product prices. */
  pricingMode?: TenantWorkspacePricingMode;
  confirmedAt: Date;
  confirmedBy?: Types.ObjectId;
  updatedAt: Date;
  updatedBy?: Types.ObjectId;
  source: TenantWorkspaceIntentSource;
};

export type TenantWorkspaceNavigation = {
  hiddenGroups: TenantWorkspaceNavigationGroup[];
  hiddenItems: TenantWorkspaceNavigationItem[];
};

export type TenantLimits = {
  locations: number;
  admins: number;
  staffMembers: number;
  inventoryItems: number;
  monthlyEmails: number;
  monthlyAutomations: number;
  aiCredits: number;
};

export type TenantDomain = {
  hostname: string;
  type: TenantDomainType;
  status: TenantDomainStatus;
  isPrimary: boolean;
};

export type TenantSettings = {
  /** @deprecated Compatibility alias for publicDefaultLanguage. */
  defaultLanguage: TenantLanguage;
  /** Missing on tenants persisted before the locale-contract rollout. */
  adminLanguage?: RolloutEligibleAppLocale;
  /** Missing on tenants persisted before the locale-contract rollout. */
  publicDefaultLanguage?: RolloutEligibleAppLocale;
  /** Missing on tenants persisted before the locale-contract rollout. */
  supportedPublicLanguages?: RolloutEligibleAppLocale[];
  currency: StudioCommerceCurrency;
  timezone: string;
  navigation?: TenantWorkspaceNavigation;
};

/**
 * Tenant-authored copy available to the public-site renderer.
 *
 * Keeping this keyed by the rollout-eligible contract prevents planned Wave 2
 * locales from leaking into persistence before they are enabled. Serializers
 * materialize every key, including for legacy cs/en-only documents.
 */
export type TenantPublicSiteLocalizedText = Record<
  RolloutEligibleAppLocale,
  string
>;

export type TenantPublicSite = {
  branding: {
    displayName: string;
    stylePreset: PublicSiteStylePreset;
    fontPreset: PublicSiteFontPreset;
    logoUrl: string;
    logoSize: number;
    logoRedirectEnabled: boolean;
    logoRedirectUrl: string;
    faviconUrl: string;
    accentColor: string;
    secondaryColor: string;
    backgroundColor: string;
    textColor: string;
    buttonTextColor: string;
    labelColor: string;
    coverImageUrl: string;
    description: TenantPublicSiteLocalizedText;
  };
  login: {
    eyebrow: TenantPublicSiteLocalizedText;
    headline: TenantPublicSiteLocalizedText;
    supportingText: TenantPublicSiteLocalizedText;
    helpText: TenantPublicSiteLocalizedText;
    backgroundImageUrl: string;
    labelColor: string;
  };
  register: {
    eyebrow: TenantPublicSiteLocalizedText;
    headline: TenantPublicSiteLocalizedText;
    supportingText: TenantPublicSiteLocalizedText;
    helpText: TenantPublicSiteLocalizedText;
    backgroundImageUrl: string;
    labelColor: string;
  };
  header: {
    navOrder: PublicSiteNavItem[];
    hiddenItems: PublicSiteNavItem[];
    primaryCta: PublicSitePrimaryCta;
    announcement: {
      text: TenantPublicSiteLocalizedText;
      url: string;
    };
  };
  footer: {
    description: TenantPublicSiteLocalizedText;
    openingHours: TenantPublicSiteLocalizedText;
    copyright: TenantPublicSiteLocalizedText;
    email: string;
    phone: string;
    address: string;
    social: {
      instagram: string;
      facebook: string;
      youtube: string;
      website: string;
    };
    legal: {
      studioRules: string;
      terms: string;
      privacy: string;
      cancellation: string;
    };
  };
  pages: {
    home: {
      eyebrow: TenantPublicSiteLocalizedText;
      headline: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
      labelColor: string;
      headlineColor: string;
      sectionOrder: PublicSiteHomeSection[];
      hiddenSections: PublicSiteHomeSection[];
      sectionContent: Record<
        PublicSiteHomeSection,
        {
          title: TenantPublicSiteLocalizedText;
          description: TenantPublicSiteLocalizedText;
        }
      >;
    };
    book: {
      visible: boolean;
      title: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
    };
    courses: {
      visible: boolean;
      title: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
    };
    memberships: {
      visible: boolean;
      title: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
    };
    vouchers: {
      visible: boolean;
      title: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
    };
    help: {
      visible: boolean;
      title: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
    };
  };
  customerPortal: {
    pages: Record<CustomerPortalPageId, { enabled: boolean }>;
    navigation: Record<CustomerPortalNavigationKey, { visible: boolean }>;
    appearance: PortalAppearance;
    courses: {
      guestCheckoutEnabled: boolean;
      locations: Array<{
        locationId: string;
        headline: TenantPublicSiteLocalizedText;
        description: TenantPublicSiteLocalizedText;
        heroImageUrl: string;
      }>;
    };
    dashboard: {
      eyebrow: TenantPublicSiteLocalizedText;
      headline: TenantPublicSiteLocalizedText;
      description: TenantPublicSiteLocalizedText;
      labelColor: string;
    };
  };
};

export type TenantPublicSiteEditor = {
  draft?: TenantPublicSite;
  published?: TenantPublicSite;
  draftRevision: number;
  publishedRevision: number;
  draftUpdatedAt?: Date;
  publishedAt?: Date;
  publishedBy?: Types.ObjectId;
  draftRestoredFromVersion?: Types.ObjectId;
};

export type TenantPublicSiteVersion = {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  sourceDraftRevision: number;
  snapshot: TenantPublicSite;
  publishedAt: Date;
  publishedBy?: Types.ObjectId;
  restoredFromVersion?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantOnboarding = {
  completed: boolean;
  currentStep: number;
  businessType?: TenantBusinessType;
  teamSize?: TenantTeamSize;
  businessDetails?: {
    country: string;
    city: string;
    address: string;
    phone: string;
  };
  bookingSetup?: {
    bookingTypes: TenantStoredBookingType[];
    confirmationMode?: TenantConfirmationMode;
  };
  completedAt?: Date;
  lastSavedAt?: Date;
};

export type Tenant = {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: TenantPlan;
  planVersion: number;
  /** Explicitly set for newly provisioned tenants; absent retains unlimited historical offerings. */
  voucherQuotaVersion?: 1;
  accessControlVersion: number;
  domains: TenantDomain[];
  modules: TenantModules;
  workspaceModules?: TenantWorkspaceModules;
  workspaceIntent?: TenantWorkspaceIntent;
  limits: TenantLimits;
  settings: TenantSettings;
  publicSite: TenantPublicSite;
  publicSiteEditor?: TenantPublicSiteEditor;
  onboarding: TenantOnboarding;
  createdAt: Date;
  updatedAt: Date;
};

export type TenantDocument = HydratedDocument<Tenant>;
export type TenantModel = Model<Tenant>;

export type TenantContext = {
  tenantId: TenantId;
  slug?: string;
  name?: string;
};

export type RequestWithTenant = Request & {
  tenantId?: unknown;
  tenant?: TenantDocument | null;
  hostnameNormalized?: string;
  userInfo?: {
    tenantId?: unknown;
    tenant?: {
      _id?: unknown;
      id?: unknown;
    };
  };
};

export type TenantFilter = {
  tenant: TenantId;
};
