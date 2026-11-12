import { TENANT_PLAN } from "./tenant.constants.js";

import type {
  TenantLimits,
  TenantModules,
  TenantPlan,
} from "./tenant.types.js";

export type PlanQuota =
  { kind: "fixed"; value: number } | { kind: "unlimited" } | { kind: "custom" };

export type PlanAutomationEntitlement =
  | PlanQuota
  | { kind: "advanced" };

export type PlanFeatureTier =
  "none" | "limited" | "basic" | "full" | "advanced" | "custom";

export type PlanProvisioning =
  "none" | "optional" | "included" | "usage_based" | "custom";

export type PlanSupportLevel =
  "email" | "priority_email_chat" | "priority" | "sla_dedicated";

/**
 * Customer-facing entitlement contract. Internal numeric safety limits remain
 * in `limits`; this object represents unlimited and negotiated limits without
 * magic sentinel numbers leaking into the billing API.
 */
export type PlanCapabilities = {
  scale: {
    locations: PlanQuota;
    teamAccounts: PlanQuota;
    customers: PlanQuota;
    bookings: PlanQuota;
    classes: PlanQuota;
    paymentVolume: PlanQuota;
  };
  booking: {
    openStudio: boolean;
    classesAndCourses: boolean;
    /** V3 distinguishes private classes/events from timed studio sessions. */
    privateCoursesAndEvents?: boolean;
    privateSessionsAndAppointments?: boolean;
    privateSessionsAndEvents: boolean;
    capacityOverlapAndActivityLimits: boolean;
    waitlists: boolean;
  };
  commerce: {
    stripePaymentsAndRefunds: boolean;
    sharioTransactionFeePercent: number;
    creditPacksAndPasses: boolean;
    vouchersAndDiscountCodes: boolean;
    recurringMemberships: boolean;
    crossLocationMembershipsAndCredits: boolean;
    pointOfSaleAndStudioPurchases: boolean;
  };
  website: {
    customerPortal: boolean;
    publicStudioWebsite: boolean;
    builder: PlanFeatureTier;
    customDomain: boolean;
    removeSharioBranding: boolean;
  };
  customers: {
    recordsAndNotes: boolean;
    tagsCustomFieldsAndSegments: PlanFeatureTier;
    waiversAndCustomForms: PlanFeatureTier;
  };
  reporting: {
    /** Commercial reporting level. Added in V3; absent on historical plans. */
    tier?: PlanFeatureTier;
    basicCalendarAndReports: boolean;
    advancedFinancialAndOperationalReports: boolean;
    consolidatedCrossLocationReports: boolean;
    googleAndOutlookCalendarSync: boolean;
  };
  migration: {
    csvMigrationCenter: boolean;
    assistedMigration: PlanProvisioning;
  };
  support: PlanSupportLevel;
  operations: {
    pieceRegistration: boolean;
    /** Basic tracking in Starter and the complete studio flow from Professional. */
    pieceTracking?: PlanFeatureTier;
    studioFlow: boolean;
    firingTracking: boolean;
    firingAndPiecePricingProfiles: boolean;
    externalPieceCharging: boolean;
    pickupNotifications: boolean;
    materialsAndInventory: boolean;
    crossLocationInventory: boolean;
    staffTasks: PlanFeatureTier;
    dailyAndWeeklyStaffPlanning: boolean;
    /** shario.io's manual Access Code module; deliberately not a smart-lock gate. */
    accessCodeManagement?: boolean;
    automatedAccessCodeEmails?: boolean;
    smartLockIntegrations: PlanProvisioning;
  };
  communications: {
    bookingConfirmationsAndReminders: boolean;
    paymentAndCancellationEmails: boolean;
    editableEmailTemplates: PlanFeatureTier;
    customAutomations: PlanAutomationEntitlement;
    /** V3 allowance; required system delivery is explicitly exempt. */
    includedEmailsPerMonth?: PlanQuota;
    automationBuilder?: PlanFeatureTier;
    essentialSystemEmailsExemptFromAllowance?: boolean;
    firingAndPickupAutomations: boolean;
    newsletterCampaigns: boolean;
    customerSegmentation: PlanFeatureTier;
    unifiedInbox: boolean;
    smsAndWhatsApp: PlanProvisioning;
  };
  ai: {
    studioAssistant: PlanFeatureTier;
    allowancePerMonth: PlanQuota;
    dailyStudioBriefing: boolean;
    /** AI firing analysis is part of the full Studio Assistant, not Starter. */
    firingInsights?: boolean;
    knowledgeHub: boolean;
    knowledgeAwareCustomerAssistant: boolean;
    commandCenter: boolean;
    businessAdvisor: boolean;
    crossLocationInsights: boolean;
    extraUsage: PlanProvisioning;
  };
  enterprise: {
    organisationAdministration: boolean;
    samlSsoAndScim: boolean;
    apiAndWebhooks: boolean;
    advancedAuditLogs: boolean;
    customRolesAndPermissions: boolean;
    customIntegrations: boolean;
    consolidatedGroupReporting: boolean;
    dedicatedMigrationAndOnboarding: boolean;
    contractualSla: boolean;
    customDevelopment: boolean;
  };
};

export type PlanConfig = {
  version: number;
  modules: TenantModules;
  limits: TenantLimits;
  /** V1 predates the public capability contract and intentionally stays intact. */
  capabilities?: PlanCapabilities;
};

const baseModules: TenantModules = {
  bookings: true,
  payments: true,
  customers: true,
  courses: false,
  memberships: false,
  credits: false,
  vouchers: false,
  automations: false,
  newsletter: false,
  firing: false,
  inventory: true,
  staff_tasks: false,
  communications: false,
  ai: false,
};

const PLAN_V1_CONFIG = {
  [TENANT_PLAN.STARTER]: {
    version: 1,
    modules: {
      ...baseModules,
    },
    limits: {
      locations: 1,
      admins: 1,
      staffMembers: 3,
      inventoryItems: 250,
      monthlyEmails: 500,
      monthlyAutomations: 0,
      aiCredits: 0,
    },
  },

  [TENANT_PLAN.PROFESSIONAL]: {
    version: 1,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      newsletter: true,
      firing: false,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 3,
      admins: 5,
      staffMembers: 15,
      inventoryItems: 5000,
      monthlyEmails: 5000,
      monthlyAutomations: 1000,
      aiCredits: 500,
    },
  },

  [TENANT_PLAN.STUDIO_PLUS]: {
    version: 1,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      newsletter: true,
      firing: false,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 10,
      admins: 20,
      staffMembers: 75,
      inventoryItems: 50000,
      monthlyEmails: 25000,
      monthlyAutomations: 10000,
      aiCredits: 1000,
    },
  },

  [TENANT_PLAN.ENTERPRISE]: {
    version: 1,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      newsletter: true,
      firing: false,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 50,
      admins: 100,
      staffMembers: 500,
      inventoryItems: 1000000,
      monthlyEmails: 100000,
      monthlyAutomations: 100000,
      aiCredits: 10000,
    },
  },
} satisfies Record<TenantPlan, PlanConfig>;

const fixed = (value: number): PlanQuota => ({ kind: "fixed", value });
const unlimited = (): PlanQuota => ({ kind: "unlimited" });
const custom = (): PlanQuota => ({ kind: "custom" });
const advancedAutomations = (): PlanAutomationEntitlement => ({
  kind: "advanced",
});

const commonScale = (locations: PlanQuota, teamAccounts: PlanQuota) => ({
  locations,
  teamAccounts,
  customers: unlimited(),
  bookings: unlimited(),
  classes: unlimited(),
  paymentVolume: unlimited(),
});

const commonBooking: PlanCapabilities["booking"] = {
  openStudio: true,
  classesAndCourses: true,
  privateSessionsAndEvents: true,
  capacityOverlapAndActivityLimits: true,
  waitlists: true,
};

const commonEnterpriseCapabilities = (enabled: boolean) => ({
  organisationAdministration: enabled,
  samlSsoAndScim: enabled,
  apiAndWebhooks: enabled,
  advancedAuditLogs: enabled,
  customRolesAndPermissions: enabled,
  customIntegrations: enabled,
  consolidatedGroupReporting: enabled,
  dedicatedMigrationAndOnboarding: enabled,
  contractualSla: enabled,
  customDevelopment: enabled,
});

const PLAN_V2_CAPABILITIES = {
  [TENANT_PLAN.STARTER]: {
    scale: commonScale(fixed(1), fixed(3)),
    booking: commonBooking,
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: false,
      crossLocationMembershipsAndCredits: false,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "none",
      waiversAndCustomForms: "none",
    },
    reporting: {
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: false,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "email",
    operations: {
      pieceRegistration: false,
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: false,
      crossLocationInventory: false,
      staffTasks: "none",
      dailyAndWeeklyStaffPlanning: false,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: fixed(3),
      firingAndPickupAutomations: false,
      newsletterCampaigns: false,
      customerSegmentation: "none",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "limited",
      allowancePerMonth: fixed(200),
      dailyStudioBriefing: false,
      knowledgeHub: false,
      knowledgeAwareCustomerAssistant: false,
      commandCenter: false,
      businessAdvisor: false,
      crossLocationInsights: false,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.PROFESSIONAL]: {
    scale: commonScale(fixed(3), fixed(15)),
    booking: commonBooking,
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: true,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "none",
      waiversAndCustomForms: "none",
    },
    reporting: {
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: false,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "priority_email_chat",
    operations: {
      pieceRegistration: false,
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: false,
      staffTasks: "full",
      dailyAndWeeklyStaffPlanning: true,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: fixed(25),
      firingAndPickupAutomations: false,
      newsletterCampaigns: false,
      customerSegmentation: "none",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "full",
      allowancePerMonth: fixed(2000),
      dailyStudioBriefing: true,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: false,
      commandCenter: false,
      businessAdvisor: false,
      crossLocationInsights: false,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.STUDIO_PLUS]: {
    scale: commonScale(fixed(10), fixed(30)),
    booking: commonBooking,
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: true,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "none",
      waiversAndCustomForms: "none",
    },
    reporting: {
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: false,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "priority",
    operations: {
      pieceRegistration: false,
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: false,
      staffTasks: "full",
      dailyAndWeeklyStaffPlanning: true,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: unlimited(),
      firingAndPickupAutomations: false,
      newsletterCampaigns: false,
      customerSegmentation: "none",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "full",
      allowancePerMonth: fixed(10000),
      dailyStudioBriefing: true,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: true,
      commandCenter: true,
      businessAdvisor: true,
      crossLocationInsights: true,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.ENTERPRISE]: {
    scale: commonScale(custom(), custom()),
    booking: commonBooking,
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: true,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "none",
      waiversAndCustomForms: "none",
    },
    reporting: {
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: false,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "priority",
    operations: {
      pieceRegistration: false,
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: false,
      staffTasks: "full",
      dailyAndWeeklyStaffPlanning: true,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: unlimited(),
      firingAndPickupAutomations: false,
      newsletterCampaigns: false,
      customerSegmentation: "none",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "full",
      allowancePerMonth: custom(),
      dailyStudioBriefing: true,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: true,
      commandCenter: true,
      businessAdvisor: true,
      crossLocationInsights: true,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },
} satisfies Record<TenantPlan, PlanCapabilities>;

const PLAN_V2_CONFIG = {
  [TENANT_PLAN.STARTER]: {
    version: 2,
    modules: {
      ...baseModules,
      courses: true,
      credits: true,
      vouchers: true,
      automations: true,
      inventory: false,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 1,
      admins: 3,
      staffMembers: 3,
      inventoryItems: 0,
      monthlyEmails: 1000,
      monthlyAutomations: 3,
      aiCredits: 200,
    },
    capabilities: PLAN_V2_CAPABILITIES.starter,
  },
  [TENANT_PLAN.PROFESSIONAL]: {
    version: 2,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 3,
      admins: 15,
      staffMembers: 15,
      inventoryItems: 5000,
      monthlyEmails: 5000,
      monthlyAutomations: 25,
      aiCredits: 2000,
    },
    capabilities: PLAN_V2_CAPABILITIES.professional,
  },
  [TENANT_PLAN.STUDIO_PLUS]: {
    version: 2,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 10,
      admins: 30,
      staffMembers: 30,
      inventoryItems: 50000,
      monthlyEmails: 20000,
      monthlyAutomations: Number.MAX_SAFE_INTEGER,
      aiCredits: 10000,
    },
    capabilities: PLAN_V2_CAPABILITIES.studio_plus,
  },
  [TENANT_PLAN.ENTERPRISE]: {
    version: 2,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      automations: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      // Sales-assisted plans replace these guardrails with agreed tenant limits.
      locations: 50,
      admins: 100,
      staffMembers: 500,
      inventoryItems: 1000000,
      monthlyEmails: 100000,
      monthlyAutomations: Number.MAX_SAFE_INTEGER,
      aiCredits: 10000,
    },
    capabilities: PLAN_V2_CAPABILITIES.enterprise,
  },
} satisfies Record<TenantPlan, PlanConfig>;

/**
 * Plan V3 is the first catalogue shaped specifically around pottery-studio
 * operating models:
 *
 * Starter runs courses; Professional runs one studio; Studio Plus adds
 * automation and two-location scale; Enterprise removes organisational caps.
 *
 * These definitions are intentionally separate from V2. Existing tenants keep
 * their stored planVersion until an explicit subscription change or migration.
 */
const PLAN_V3_CAPABILITIES = {
  [TENANT_PLAN.STARTER]: {
    scale: commonScale(fixed(1), fixed(1)),
    booking: {
      openStudio: false,
      classesAndCourses: true,
      privateCoursesAndEvents: true,
      privateSessionsAndAppointments: false,
      privateSessionsAndEvents: false,
      capacityOverlapAndActivityLimits: false,
      waitlists: true,
    },
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: false,
      vouchersAndDiscountCodes: true,
      recurringMemberships: false,
      crossLocationMembershipsAndCredits: false,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "none",
      waiversAndCustomForms: "none",
    },
    reporting: {
      tier: "limited",
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: false,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: false,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "email",
    operations: {
      pieceRegistration: false,
      pieceTracking: "none",
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: false,
      crossLocationInventory: false,
      staffTasks: "none",
      dailyAndWeeklyStaffPlanning: false,
      accessCodeManagement: false,
      automatedAccessCodeEmails: false,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "basic",
      customAutomations: fixed(0),
      includedEmailsPerMonth: fixed(500),
      automationBuilder: "none",
      essentialSystemEmailsExemptFromAllowance: true,
      firingAndPickupAutomations: false,
      newsletterCampaigns: false,
      customerSegmentation: "none",
      unifiedInbox: false,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "limited",
      allowancePerMonth: fixed(200),
      dailyStudioBriefing: false,
      firingInsights: false,
      knowledgeHub: false,
      knowledgeAwareCustomerAssistant: false,
      commandCenter: false,
      businessAdvisor: false,
      crossLocationInsights: false,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.PROFESSIONAL]: {
    scale: commonScale(fixed(1), fixed(3)),
    booking: {
      ...commonBooking,
      privateCoursesAndEvents: true,
      privateSessionsAndAppointments: true,
    },
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: false,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: false,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "full",
      waiversAndCustomForms: "none",
    },
    reporting: {
      tier: "full",
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: false,
      googleAndOutlookCalendarSync: true,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "none",
    },
    support: "priority_email_chat",
    operations: {
      pieceRegistration: false,
      pieceTracking: "none",
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: false,
      staffTasks: "full",
      dailyAndWeeklyStaffPlanning: true,
      accessCodeManagement: false,
      automatedAccessCodeEmails: false,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: fixed(3),
      includedEmailsPerMonth: fixed(2_500),
      automationBuilder: "basic",
      essentialSystemEmailsExemptFromAllowance: true,
      firingAndPickupAutomations: false,
      newsletterCampaigns: true,
      customerSegmentation: "full",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "full",
      allowancePerMonth: fixed(2_000),
      dailyStudioBriefing: true,
      firingInsights: false,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: false,
      commandCenter: false,
      businessAdvisor: false,
      crossLocationInsights: false,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.STUDIO_PLUS]: {
    scale: commonScale(fixed(2), fixed(6)),
    booking: {
      ...commonBooking,
      privateCoursesAndEvents: true,
      privateSessionsAndAppointments: true,
    },
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: true,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: true,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "advanced",
      waiversAndCustomForms: "none",
    },
    reporting: {
      tier: "advanced",
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: true,
      googleAndOutlookCalendarSync: true,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "optional",
    },
    support: "priority",
    operations: {
      pieceRegistration: false,
      pieceTracking: "none",
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: true,
      staffTasks: "full",
      dailyAndWeeklyStaffPlanning: true,
      accessCodeManagement: true,
      automatedAccessCodeEmails: true,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "full",
      customAutomations: advancedAutomations(),
      includedEmailsPerMonth: fixed(5_000),
      automationBuilder: "advanced",
      essentialSystemEmailsExemptFromAllowance: true,
      firingAndPickupAutomations: false,
      newsletterCampaigns: true,
      customerSegmentation: "advanced",
      unifiedInbox: true,
      smsAndWhatsApp: "none",
    },
    ai: {
      studioAssistant: "full",
      allowancePerMonth: fixed(10_000),
      dailyStudioBriefing: true,
      firingInsights: false,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: true,
      commandCenter: true,
      businessAdvisor: true,
      crossLocationInsights: true,
      extraUsage: "none",
    },
    enterprise: commonEnterpriseCapabilities(false),
  },

  [TENANT_PLAN.ENTERPRISE]: {
    scale: commonScale(unlimited(), unlimited()),
    booking: {
      ...commonBooking,
      privateCoursesAndEvents: true,
      privateSessionsAndAppointments: true,
    },
    commerce: {
      stripePaymentsAndRefunds: true,
      sharioTransactionFeePercent: 0,
      creditPacksAndPasses: true,
      vouchersAndDiscountCodes: true,
      recurringMemberships: true,
      crossLocationMembershipsAndCredits: true,
      pointOfSaleAndStudioPurchases: false,
    },
    website: {
      customerPortal: true,
      publicStudioWebsite: true,
      builder: "full",
      customDomain: true,
      removeSharioBranding: false,
    },
    customers: {
      recordsAndNotes: true,
      tagsCustomFieldsAndSegments: "advanced",
      waiversAndCustomForms: "custom",
    },
    reporting: {
      tier: "custom",
      basicCalendarAndReports: true,
      advancedFinancialAndOperationalReports: true,
      consolidatedCrossLocationReports: true,
      googleAndOutlookCalendarSync: true,
    },
    migration: {
      csvMigrationCenter: true,
      assistedMigration: "included",
    },
    support: "sla_dedicated",
    operations: {
      pieceRegistration: false,
      pieceTracking: "none",
      studioFlow: false,
      firingTracking: false,
      firingAndPiecePricingProfiles: false,
      externalPieceCharging: false,
      pickupNotifications: false,
      materialsAndInventory: true,
      crossLocationInventory: true,
      staffTasks: "custom",
      dailyAndWeeklyStaffPlanning: true,
      accessCodeManagement: true,
      automatedAccessCodeEmails: true,
      smartLockIntegrations: "none",
    },
    communications: {
      bookingConfirmationsAndReminders: true,
      paymentAndCancellationEmails: true,
      editableEmailTemplates: "custom",
      customAutomations: unlimited(),
      includedEmailsPerMonth: custom(),
      automationBuilder: "custom",
      essentialSystemEmailsExemptFromAllowance: true,
      firingAndPickupAutomations: false,
      newsletterCampaigns: true,
      customerSegmentation: "custom",
      unifiedInbox: true,
      smsAndWhatsApp: "custom",
    },
    ai: {
      studioAssistant: "custom",
      allowancePerMonth: custom(),
      dailyStudioBriefing: true,
      firingInsights: false,
      knowledgeHub: true,
      knowledgeAwareCustomerAssistant: true,
      commandCenter: true,
      businessAdvisor: true,
      crossLocationInsights: true,
      extraUsage: "custom",
    },
    enterprise: commonEnterpriseCapabilities(true),
  },
} satisfies Record<TenantPlan, PlanCapabilities>;

const PLAN_V3_CONFIG = {
  [TENANT_PLAN.STARTER]: {
    version: 3,
    modules: {
      ...baseModules,
      courses: true,
      vouchers: true,
      access_codes: false,
      firing: false,
      inventory: false,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 1,
      admins: 1,
      staffMembers: 1,
      inventoryItems: 0,
      monthlyEmails: 500,
      monthlyAutomations: 0,
      aiCredits: 200,
    },
    capabilities: PLAN_V3_CAPABILITIES.starter,
  },
  [TENANT_PLAN.PROFESSIONAL]: {
    version: 3,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      access_codes: false,
      automations: true,
      newsletter: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 1,
      admins: 3,
      staffMembers: 3,
      inventoryItems: Number.MAX_SAFE_INTEGER,
      monthlyEmails: 2_500,
      monthlyAutomations: 3,
      aiCredits: 2_000,
    },
    capabilities: PLAN_V3_CAPABILITIES.professional,
  },
  [TENANT_PLAN.STUDIO_PLUS]: {
    version: 3,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      access_codes: true,
      automations: true,
      newsletter: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: 2,
      admins: 6,
      staffMembers: 6,
      inventoryItems: Number.MAX_SAFE_INTEGER,
      monthlyEmails: 5_000,
      monthlyAutomations: Number.MAX_SAFE_INTEGER,
      aiCredits: 10_000,
    },
    capabilities: PLAN_V3_CAPABILITIES.studio_plus,
  },
  [TENANT_PLAN.ENTERPRISE]: {
    version: 3,
    modules: {
      ...baseModules,
      courses: true,
      memberships: true,
      credits: true,
      vouchers: true,
      access_codes: true,
      automations: true,
      newsletter: true,
      firing: false,
      inventory: true,
      staff_tasks: true,
      communications: true,
      ai: true,
    },
    limits: {
      locations: Number.MAX_SAFE_INTEGER,
      admins: Number.MAX_SAFE_INTEGER,
      staffMembers: Number.MAX_SAFE_INTEGER,
      inventoryItems: Number.MAX_SAFE_INTEGER,
      // Contract-specific overrides are stored on the tenant at provisioning.
      monthlyEmails: 100_000,
      monthlyAutomations: Number.MAX_SAFE_INTEGER,
      aiCredits: 10_000,
    },
    capabilities: PLAN_V3_CAPABILITIES.enterprise,
  },
} satisfies Record<TenantPlan, PlanConfig>;

type PlanVersionDefinition = {
  currentVersion: number;
  versions: Readonly<Record<number, PlanConfig>>;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }

  return value;
};

const cloneCapabilities = (
  capabilities: PlanCapabilities | undefined,
): PlanCapabilities | undefined =>
  capabilities ? structuredClone(capabilities) : undefined;

const freezePlanConfig = (config: PlanConfig): PlanConfig =>
  deepFreeze({
    version: config.version,
    modules: { ...config.modules },
    limits: { ...config.limits },
    ...(config.capabilities
      ? { capabilities: cloneCapabilities(config.capabilities) }
      : {}),
  });

const PLAN_V1_IMMUTABLE = {
  [TENANT_PLAN.STARTER]: freezePlanConfig(PLAN_V1_CONFIG.starter),
  [TENANT_PLAN.PROFESSIONAL]: freezePlanConfig(PLAN_V1_CONFIG.professional),
  [TENANT_PLAN.STUDIO_PLUS]: freezePlanConfig(PLAN_V1_CONFIG.studio_plus),
  [TENANT_PLAN.ENTERPRISE]: freezePlanConfig(PLAN_V1_CONFIG.enterprise),
} as const;

const PLAN_V2_IMMUTABLE = {
  [TENANT_PLAN.STARTER]: freezePlanConfig(PLAN_V2_CONFIG.starter),
  [TENANT_PLAN.PROFESSIONAL]: freezePlanConfig(PLAN_V2_CONFIG.professional),
  [TENANT_PLAN.STUDIO_PLUS]: freezePlanConfig(PLAN_V2_CONFIG.studio_plus),
  [TENANT_PLAN.ENTERPRISE]: freezePlanConfig(PLAN_V2_CONFIG.enterprise),
} as const;

const PLAN_V3_IMMUTABLE = {
  [TENANT_PLAN.STARTER]: freezePlanConfig(PLAN_V3_CONFIG.starter),
  [TENANT_PLAN.PROFESSIONAL]: freezePlanConfig(PLAN_V3_CONFIG.professional),
  [TENANT_PLAN.STUDIO_PLUS]: freezePlanConfig(PLAN_V3_CONFIG.studio_plus),
  [TENANT_PLAN.ENTERPRISE]: freezePlanConfig(PLAN_V3_CONFIG.enterprise),
} as const;

/**
 * Immutable, code-first plan history.
 *
 * Versions 1 and 2 are deliberately unchanged. New subscriptions use V3 while
 * existing tenants retain their stored version until an explicit migration or
 * plan change is performed.
 */
export const PLAN_VERSION_CATALOG = Object.freeze({
  [TENANT_PLAN.STARTER]: Object.freeze({
    currentVersion: 3,
    versions: Object.freeze({
      1: PLAN_V1_IMMUTABLE.starter,
      2: PLAN_V2_IMMUTABLE.starter,
      3: PLAN_V3_IMMUTABLE.starter,
    }),
  }),
  [TENANT_PLAN.PROFESSIONAL]: Object.freeze({
    currentVersion: 3,
    versions: Object.freeze({
      1: PLAN_V1_IMMUTABLE.professional,
      2: PLAN_V2_IMMUTABLE.professional,
      3: PLAN_V3_IMMUTABLE.professional,
    }),
  }),
  [TENANT_PLAN.STUDIO_PLUS]: Object.freeze({
    currentVersion: 3,
    versions: Object.freeze({
      1: PLAN_V1_IMMUTABLE.studio_plus,
      2: PLAN_V2_IMMUTABLE.studio_plus,
      3: PLAN_V3_IMMUTABLE.studio_plus,
    }),
  }),
  [TENANT_PLAN.ENTERPRISE]: Object.freeze({
    currentVersion: 3,
    versions: Object.freeze({
      1: PLAN_V1_IMMUTABLE.enterprise,
      2: PLAN_V2_IMMUTABLE.enterprise,
      3: PLAN_V3_IMMUTABLE.enterprise,
    }),
  }),
}) satisfies Readonly<Record<TenantPlan, PlanVersionDefinition>>;

/** Backwards-compatible view of each plan's current version. */
export const PLAN_CONFIG = Object.freeze({
  [TENANT_PLAN.STARTER]:
    PLAN_VERSION_CATALOG.starter.versions[
      PLAN_VERSION_CATALOG.starter.currentVersion
    ],
  [TENANT_PLAN.PROFESSIONAL]:
    PLAN_VERSION_CATALOG.professional.versions[
      PLAN_VERSION_CATALOG.professional.currentVersion
    ],
  [TENANT_PLAN.STUDIO_PLUS]:
    PLAN_VERSION_CATALOG.studio_plus.versions[
      PLAN_VERSION_CATALOG.studio_plus.currentVersion
    ],
  [TENANT_PLAN.ENTERPRISE]:
    PLAN_VERSION_CATALOG.enterprise.versions[
      PLAN_VERSION_CATALOG.enterprise.currentVersion
    ],
}) satisfies Readonly<Record<TenantPlan, PlanConfig>>;

export const getCurrentPlanVersion = (plan: TenantPlan): number =>
  (PLAN_VERSION_CATALOG[plan] as PlanVersionDefinition).currentVersion;

export const isKnownPlanVersion = (
  plan: TenantPlan,
  version: number,
): boolean =>
  Boolean(
    (PLAN_VERSION_CATALOG[plan] as PlanVersionDefinition).versions[version],
  );

export const getKnownPlanVersions = (plan: TenantPlan): number[] =>
  Object.keys((PLAN_VERSION_CATALOG[plan] as PlanVersionDefinition).versions)
    .map(Number)
    .filter((version) => Number.isInteger(version) && version > 0)
    .sort((a, b) => a - b);

export const getPlanConfig = (
  plan: TenantPlan,
  version: number = getCurrentPlanVersion(plan),
): PlanConfig => {
  const config = (PLAN_VERSION_CATALOG[plan] as PlanVersionDefinition).versions[
    version
  ];

  if (!config) {
    throw new Error(`Unknown ${plan} plan version: ${version}`);
  }

  return {
    version: config.version,
    modules: { ...config.modules },
    limits: { ...config.limits },
    ...(config.capabilities
      ? { capabilities: cloneCapabilities(config.capabilities) }
      : {}),
  };
};

export const getPlanCapabilities = (
  plan: TenantPlan,
  version: number = getCurrentPlanVersion(plan),
): PlanCapabilities | null => getPlanConfig(plan, version).capabilities ?? null;

/** Voucher quota rollout is independent of immutable commercial plan versions. */
export const VOUCHER_OFFERING_QUOTA_VERSION = 1 as const;
export const VOUCHER_OFFERING_ALLOWANCES: Readonly<Record<TenantPlan, number | null>> = Object.freeze({
  [TENANT_PLAN.STARTER]: 3,
  [TENANT_PLAN.PROFESSIONAL]: 10,
  [TENANT_PLAN.STUDIO_PLUS]: 25,
  [TENANT_PLAN.ENTERPRISE]: null,
});
