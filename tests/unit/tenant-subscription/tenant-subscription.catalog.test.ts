import { describe, expect, it } from "vitest";
import { INTERNATIONAL_OFFER_ID } from "@/modules/tenant-subscription/tenant-subscription.prices.js";

import {
  COMMERCIAL_OFFER_CATALOG,
  CURRENT_COMMERCIAL_OFFER_ID,
  FOUNDING_OFFER_ID,
  PLAN_V3_OFFER_ID,
  getCommercialAmount,
  getCommercialPriceSpec,
  getCommercialPriceSpecFromCatalog,
  getCommercialPriceSpecForOffer,
  getCommercialPriceSpecsFromCatalog,
  getCommercialStripeLookupKey,
  type CommercialOfferCatalog,
} from "@/modules/tenant-subscription/tenant-subscription.commercial.js";
import {
  buildStripePriceReferencesForCommercialCatalog,
  getBasePlanCatalog,
  getPlanChangeTiming,
  getPlanSelectionFromStripeReferences,
  getPlanSelectionFromStripeLookupKey,
  getStripePriceLookupKey,
  getStripePriceReference,
  PLATFORM_SUBSCRIPTION_CURRENCIES,
  PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY,
  PLATFORM_SUBSCRIPTION_NEW_SALE_CURRENCIES,
} from "@/modules/tenant-subscription/tenant-subscription.catalog.js";
import { BILLING_INTERVAL } from "@/modules/tenant-subscription/tenant-subscription.constants.js";
import { TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import {
  getCurrentPlanVersion,
  getKnownPlanVersions,
  getPlanConfig,
  isKnownPlanVersion,
} from "@/modules/tenants/tenant.plan.js";

describe("getPlanChangeTiming", () => {
  it("applies plan upgrades immediately", () => {
    expect(
      getPlanChangeTiming({
        currentPlan: TENANT_PLAN.STARTER,
        currentInterval: BILLING_INTERVAL.MONTHLY,
        targetPlan: TENANT_PLAN.PROFESSIONAL,
        targetInterval: BILLING_INTERVAL.MONTHLY,
      }),
    ).toBe("immediate");
  });

  it("schedules plan downgrades for the period end", () => {
    expect(
      getPlanChangeTiming({
        currentPlan: TENANT_PLAN.STUDIO_PLUS,
        currentInterval: BILLING_INTERVAL.MONTHLY,
        targetPlan: TENANT_PLAN.PROFESSIONAL,
        targetInterval: BILLING_INTERVAL.MONTHLY,
      }),
    ).toBe("period_end");
  });

  it("moves monthly to yearly immediately", () => {
    expect(
      getPlanChangeTiming({
        currentPlan: TENANT_PLAN.PROFESSIONAL,
        currentInterval: BILLING_INTERVAL.MONTHLY,
        targetPlan: TENANT_PLAN.PROFESSIONAL,
        targetInterval: BILLING_INTERVAL.YEARLY,
      }),
    ).toBe("immediate");
  });

  it("moves yearly to monthly at renewal", () => {
    expect(
      getPlanChangeTiming({
        currentPlan: TENANT_PLAN.PROFESSIONAL,
        currentInterval: BILLING_INTERVAL.YEARLY,
        targetPlan: TENANT_PLAN.PROFESSIONAL,
        targetInterval: BILLING_INTERVAL.MONTHLY,
      }),
    ).toBe("period_end");
  });

  it("recognizes an unchanged plan", () => {
    expect(
      getPlanChangeTiming({
        currentPlan: TENANT_PLAN.STARTER,
        currentInterval: BILLING_INTERVAL.MONTHLY,
        targetPlan: TENANT_PLAN.STARTER,
        targetInterval: BILLING_INTERVAL.MONTHLY,
      }),
    ).toBe("none");
  });
});

describe("versioned plan entitlements", () => {
  it("publishes V3 while retaining immutable V1 and V2 configurations", () => {
    expect(getKnownPlanVersions(TENANT_PLAN.PROFESSIONAL)).toEqual([1, 2, 3]);
    expect(getCurrentPlanVersion(TENANT_PLAN.PROFESSIONAL)).toBe(3);
    expect(isKnownPlanVersion(TENANT_PLAN.PROFESSIONAL, 1)).toBe(true);
    expect(isKnownPlanVersion(TENANT_PLAN.PROFESSIONAL, 2)).toBe(true);
    expect(isKnownPlanVersion(TENANT_PLAN.PROFESSIONAL, 3)).toBe(true);
    expect(isKnownPlanVersion(TENANT_PLAN.PROFESSIONAL, 999)).toBe(false);

    const v1 = getPlanConfig(TENANT_PLAN.PROFESSIONAL, 1);
    expect(v1).toMatchObject({
      version: 1,
      modules: { newsletter: true, ai: true },
      limits: {
        admins: 5,
        staffMembers: 15,
        monthlyAutomations: 1000,
        aiCredits: 500,
      },
    });
    expect(v1.capabilities).toBeUndefined();
  });

  it("sets the V2 launch limits and modules without growth-volume caps", () => {
    const starter = getPlanConfig(TENANT_PLAN.STARTER, 2);
    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2);
    const studioPlus = getPlanConfig(TENANT_PLAN.STUDIO_PLUS, 2);

    expect(starter.limits).toMatchObject({
      locations: 1,
      staffMembers: 3,
      monthlyEmails: 1000,
      monthlyAutomations: 3,
      aiCredits: 200,
    });
    expect(professional.limits).toMatchObject({
      locations: 3,
      staffMembers: 15,
      monthlyEmails: 5000,
      monthlyAutomations: 25,
      aiCredits: 2000,
    });
    expect(studioPlus.limits).toMatchObject({
      locations: 10,
      staffMembers: 30,
      monthlyEmails: 20000,
      aiCredits: 10000,
    });

    expect(starter.modules).toMatchObject({
      courses: true,
      credits: true,
      vouchers: true,
      automations: true,
      communications: true,
      ai: true,
      memberships: false,
      inventory: false,
      firing: false,
      newsletter: false,
    });
    expect(professional.modules).toMatchObject({
      memberships: true,
      inventory: true,
      firing: false,
      newsletter: false,
    });
    expect(studioPlus.modules.newsletter).toBe(false);

    for (const plan of [starter, professional, studioPlus]) {
      expect(plan.capabilities?.scale.customers).toEqual({
        kind: "unlimited",
      });
      expect(plan.capabilities?.scale.bookings).toEqual({
        kind: "unlimited",
      });
      expect(plan.capabilities?.scale.classes).toEqual({ kind: "unlimited" });
      expect(plan.capabilities?.scale.paymentVolume).toEqual({
        kind: "unlimited",
      });
    }
  });

  it("represents aggregate seats, unlimited usage and custom limits explicitly", () => {
    expect(
      getPlanConfig(TENANT_PLAN.STARTER, 2).capabilities?.scale.teamAccounts,
    ).toEqual({ kind: "fixed", value: 3 });
    expect(
      getPlanConfig(TENANT_PLAN.STUDIO_PLUS, 2).capabilities?.communications
        .customAutomations,
    ).toEqual({ kind: "unlimited" });
    expect(
      getPlanConfig(TENANT_PLAN.ENTERPRISE, 2).capabilities?.scale.locations,
    ).toEqual({ kind: "custom" });
  });

  it("does not publish roadmap features as production entitlements", () => {
    const starter = getPlanConfig(TENANT_PLAN.STARTER, 2).capabilities;
    const enterprise = getPlanConfig(TENANT_PLAN.ENTERPRISE, 2).capabilities;
    const studioPlus = getPlanConfig(TENANT_PLAN.STUDIO_PLUS, 2).capabilities;

    expect(starter?.website.builder).toBe("full");
    expect(starter?.reporting.advancedFinancialAndOperationalReports).toBe(
      true,
    );
    expect(starter?.communications.editableEmailTemplates).toBe("full");
    expect(starter?.communications.unifiedInbox).toBe(true);
    expect(starter?.communications.includedEmailsPerMonth).toBeUndefined();
    expect(studioPlus?.website.removeSharioBranding).toBe(false);
    expect(studioPlus?.reporting.googleAndOutlookCalendarSync).toBe(false);
    expect(studioPlus?.operations.smartLockIntegrations).toBe("none");
    expect(studioPlus?.communications.smsAndWhatsApp).toBe("none");
    expect(studioPlus?.communications.newsletterCampaigns).toBe(false);
    expect(studioPlus?.customers.waiversAndCustomForms).toBe("none");
    expect(studioPlus?.ai.extraUsage).toBe("none");
    expect(enterprise?.enterprise.samlSsoAndScim).toBe(false);
    expect(enterprise?.enterprise.apiAndWebhooks).toBe(false);
    expect(enterprise?.enterprise.contractualSla).toBe(false);
  });

  it("returns defensive capability copies", () => {
    const first = getPlanConfig(TENANT_PLAN.STARTER, 2);
    if (!first.capabilities) throw new Error("Expected V2 capabilities.");

    first.capabilities.booking.openStudio = false;

    expect(
      getPlanConfig(TENANT_PLAN.STARTER, 2).capabilities?.booking.openStudio,
    ).toBe(true);
  });

  it("publishes the exact V3 studio scale and feature boundaries", () => {
    const starter = getPlanConfig(TENANT_PLAN.STARTER, 3);
    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL, 3);
    const studioPlus = getPlanConfig(TENANT_PLAN.STUDIO_PLUS, 3);
    const enterprise = getPlanConfig(TENANT_PLAN.ENTERPRISE, 3);

    expect(starter.limits).toMatchObject({
      locations: 1,
      admins: 1,
      staffMembers: 1,
      monthlyEmails: 500,
      monthlyAutomations: 0,
    });
    expect(professional.limits).toMatchObject({
      locations: 1,
      admins: 3,
      staffMembers: 3,
      monthlyEmails: 2_500,
      monthlyAutomations: 3,
    });
    expect(studioPlus.limits).toMatchObject({
      locations: 2,
      admins: 6,
      staffMembers: 6,
      monthlyEmails: 5_000,
      monthlyAutomations: Number.MAX_SAFE_INTEGER,
    });

    expect(starter.modules).toMatchObject({
      courses: true,
      firing: false,
      memberships: false,
      credits: false,
      automations: false,
      inventory: false,
      staff_tasks: false,
      access_codes: false,
    });
    expect(professional.modules).toMatchObject({
      memberships: true,
      credits: true,
      automations: true,
      inventory: true,
      staff_tasks: true,
      access_codes: false,
    });
    expect(studioPlus.modules.access_codes).toBe(true);
    expect(enterprise.modules.access_codes).toBe(true);

    expect(starter.capabilities).toMatchObject({
      scale: {
        locations: { kind: "fixed", value: 1 },
        teamAccounts: { kind: "fixed", value: 1 },
      },
      booking: {
        openStudio: false,
        privateCoursesAndEvents: true,
        privateSessionsAndAppointments: false,
        privateSessionsAndEvents: false,
        waitlists: true,
      },
      operations: {
        pieceTracking: "none",
        firingTracking: false,
        firingAndPiecePricingProfiles: false,
        externalPieceCharging: false,
        accessCodeManagement: false,
        smartLockIntegrations: "none",
      },
      reporting: { tier: "limited" },
      communications: {
        customAutomations: { kind: "fixed", value: 0 },
        includedEmailsPerMonth: { kind: "fixed", value: 500 },
        essentialSystemEmailsExemptFromAllowance: true,
      },
      ai: { studioAssistant: "limited" },
    });
    expect(professional.capabilities).toMatchObject({
      scale: {
        locations: { kind: "fixed", value: 1 },
        teamAccounts: { kind: "fixed", value: 3 },
      },
      booking: { openStudio: true },
      operations: {
        firingAndPiecePricingProfiles: false,
        materialsAndInventory: true,
        accessCodeManagement: false,
      },
      communications: {
        customAutomations: { kind: "fixed", value: 3 },
        includedEmailsPerMonth: { kind: "fixed", value: 2_500 },
        automationBuilder: "basic",
      },
      ai: {
        dailyStudioBriefing: true,
        knowledgeHub: true,
        knowledgeAwareCustomerAssistant: false,
        commandCenter: false,
        businessAdvisor: false,
        crossLocationInsights: false,
      },
    });
    expect(studioPlus.capabilities).toMatchObject({
      scale: {
        locations: { kind: "fixed", value: 2 },
        teamAccounts: { kind: "fixed", value: 6 },
      },
      website: { customDomain: true },
      operations: {
        accessCodeManagement: true,
        automatedAccessCodeEmails: true,
        smartLockIntegrations: "none",
      },
      communications: {
        customAutomations: { kind: "advanced" },
        includedEmailsPerMonth: { kind: "fixed", value: 5_000 },
        automationBuilder: "advanced",
      },
      ai: { knowledgeHub: true, crossLocationInsights: true },
    });
    expect(enterprise.capabilities).toMatchObject({
      scale: {
        locations: { kind: "unlimited" },
        teamAccounts: { kind: "unlimited" },
      },
      communications: {
        includedEmailsPerMonth: { kind: "custom" },
        customAutomations: { kind: "unlimited" },
      },
      enterprise: {
        organisationAdministration: true,
        samlSsoAndScim: true,
        apiAndWebhooks: true,
        contractualSla: true,
      },
    });

    for (const plan of [starter, professional, studioPlus, enterprise]) {
      expect(plan.capabilities?.scale.customers).toEqual({ kind: "unlimited" });
      expect(plan.capabilities?.scale.bookings).toEqual({ kind: "unlimited" });
      expect(plan.capabilities?.scale.classes).toEqual({ kind: "unlimited" });
      expect(plan.capabilities?.scale.paymentVolume).toEqual({
        kind: "unlimited",
      });
    }
  });
});

describe("append-only commercial offers", () => {
  it("keeps the active offer in append-only commercial history", () => {
    expect(CURRENT_COMMERCIAL_OFFER_ID).toBe(INTERNATIONAL_OFFER_ID);
    expect(Object.keys(COMMERCIAL_OFFER_CATALOG)).toEqual([
      FOUNDING_OFFER_ID,
      PLAN_V3_OFFER_ID,
      INTERNATIONAL_OFFER_ID,
    ]);
    expect(COMMERCIAL_OFFER_CATALOG[FOUNDING_OFFER_ID].founding).toBe(true);
    expect(COMMERCIAL_OFFER_CATALOG[PLAN_V3_OFFER_ID].founding).toBe(false);
    expect(
      COMMERCIAL_OFFER_CATALOG[FOUNDING_OFFER_ID].plans.professional
        .entitlementVersion,
    ).toBe(2);
    expect(
      COMMERCIAL_OFFER_CATALOG[PLAN_V3_OFFER_ID].plans.professional
        .entitlementVersion,
    ).toBe(3);
    expect(Object.isFrozen(COMMERCIAL_OFFER_CATALOG)).toBe(true);
  });

  it("publishes the exact CZK and EUR fixed prices in minor units", () => {
    expect(
      getCommercialAmount(TENANT_PLAN.STARTER, BILLING_INTERVAL.MONTHLY, "CZK"),
    ).toBe(99_000);
    expect(
      getCommercialAmount(TENANT_PLAN.STARTER, BILLING_INTERVAL.MONTHLY, "EUR"),
    ).toBe(3_900);
    expect(
      getCommercialAmount(
        TENANT_PLAN.PROFESSIONAL,
        BILLING_INTERVAL.YEARLY,
        "CZK",
      ),
    ).toBe(1_990_000);
    expect(
      getCommercialAmount(
        TENANT_PLAN.STUDIO_PLUS,
        BILLING_INTERVAL.YEARLY,
        "EUR",
      ),
    ).toBe(169_000);
  });

  it("gives two months free on every self-serve annual price", () => {
    for (const plan of [
      TENANT_PLAN.STARTER,
      TENANT_PLAN.PROFESSIONAL,
      TENANT_PLAN.STUDIO_PLUS,
    ]) {
      for (const currency of ["CZK", "EUR"] as const) {
        const monthly = getCommercialAmount(
          plan,
          BILLING_INTERVAL.MONTHLY,
          currency,
        );
        const yearly = getCommercialAmount(
          plan,
          BILLING_INTERVAL.YEARLY,
          currency,
        );

        expect(yearly).toBe((monthly ?? 0) * 10);
      }
    }
  });

  it("keeps Enterprise sales-assisted with custom annual billing", () => {
    const enterprise = getBasePlanCatalog().find(
      ({ id }) => id === TENANT_PLAN.ENTERPRISE,
    );

    expect(enterprise?.selfServe).toBe(false);
    expect(enterprise?.commercial.recurring.monthly).toEqual({
      type: "from",
      amounts: {
        EUR: 31_900,
        USD: 35_900,
        CZK: 799_000,
        GBP: 27_900,
        CHF: 29_900,
        PLN: 139_900,
        DKK: 239_900,
        SEK: 359_900,
        NOK: 339_900,
        CAD: 50_900,
        AUD: 51_900,
      },
    });
    expect(enterprise?.commercial.recurring.yearly).toEqual({
      type: "custom",
      amounts: null,
    });
    expect(enterprise?.commercial.onboarding).toBeNull();
    expect(
      COMMERCIAL_OFFER_CATALOG[FOUNDING_OFFER_ID].plans.enterprise.onboarding,
    ).toEqual({
      type: "from",
      amounts: { CZK: 2_000_000, EUR: 79_000 },
    });
  });

  it("separates the offer id from entitlement versions and lookup keys", () => {
    expect(
      getCommercialStripeLookupKey(
        TENANT_PLAN.STARTER,
        BILLING_INTERVAL.MONTHLY,
      ),
    ).toBe(
      `shario_${CURRENT_COMMERCIAL_OFFER_ID}_${TENANT_PLAN.STARTER}_${BILLING_INTERVAL.MONTHLY}`,
    );

    expect(
      getStripePriceLookupKey(TENANT_PLAN.STARTER, BILLING_INTERVAL.MONTHLY, 1),
    ).toBe("shario_starter_monthly_v1");

    const foundingKey = getStripePriceLookupKey(
      TENANT_PLAN.STARTER,
      BILLING_INTERVAL.MONTHLY,
      2,
    );
    expect(foundingKey).toBe("shario_founding_2026_v1_starter_monthly");
    expect(getPlanSelectionFromStripeLookupKey(foundingKey)).toEqual({
      plan: TENANT_PLAN.STARTER,
      planVersion: 2,
      offerId: FOUNDING_OFFER_ID,
      billingInterval: BILLING_INTERVAL.MONTHLY,
    });
    expect(
      getStripePriceReference(
        TENANT_PLAN.STARTER,
        BILLING_INTERVAL.MONTHLY,
        2,
        FOUNDING_OFFER_ID,
      ),
    ).toMatchObject({
      offerId: FOUNDING_OFFER_ID,
      lookupKey: foundingKey,
      expectedAmounts: { CZK: 99_000, EUR: 3_900 },
    });
    expect(
      getStripePriceReference(TENANT_PLAN.STARTER, BILLING_INTERVAL.MONTHLY, 2),
    ).toMatchObject({
      offerId: FOUNDING_OFFER_ID,
      lookupKey: foundingKey,
    });

    const currentKey = getStripePriceLookupKey(
      TENANT_PLAN.STARTER,
      BILLING_INTERVAL.MONTHLY,
      3,
    );
    expect(currentKey).toBe("shario_international_2026_v1_starter_monthly");
    expect(
      getStripePriceReference(TENANT_PLAN.STARTER, BILLING_INTERVAL.MONTHLY, 3),
    ).toMatchObject({
      offerId: INTERNATIONAL_OFFER_ID,
      lookupKey: currentKey,
      expectedAmounts: { CZK: 99_000, EUR: 3_900 },
    });
  });

  it("resolves two offers that share one entitlement version independently", () => {
    const founding = COMMERCIAL_OFFER_CATALOG[FOUNDING_OFFER_ID];
    const historicalOfferId = "synthetic_2025_v1";
    const currentOfferId = "synthetic_2026_v2";
    const offerCatalog = {
      [historicalOfferId]: {
        ...structuredClone(founding),
        id: historicalOfferId,
        active: false,
        founding: false,
      },
      [currentOfferId]: {
        ...structuredClone(founding),
        id: currentOfferId,
        founding: false,
      },
    } satisfies CommercialOfferCatalog;
    const specs = getCommercialPriceSpecsFromCatalog({
      offerCatalog,
      plan: TENANT_PLAN.STARTER,
      billingInterval: BILLING_INTERVAL.MONTHLY,
      planVersion: 2,
    });

    expect(
      specs.map(({ offerId, lookupKey }) => ({ offerId, lookupKey })),
    ).toEqual([
      {
        offerId: historicalOfferId,
        lookupKey: `shario_${historicalOfferId}_starter_monthly`,
      },
      {
        offerId: currentOfferId,
        lookupKey: `shario_${currentOfferId}_starter_monthly`,
      },
    ]);

    const references = buildStripePriceReferencesForCommercialCatalog({
      offerCatalog,
      currentOfferId,
      plan: TENANT_PLAN.STARTER,
      interval: BILLING_INTERVAL.MONTHLY,
      planVersion: 2,
      environment: {
        STRIPE_SYNTHETIC_2025_V1_STARTER_MONTHLY_PRICE_ID: "price_historical",
        STRIPE_SYNTHETIC_2026_V2_STARTER_MONTHLY_PRICE_ID: "price_current",
      },
    });

    expect(
      getPlanSelectionFromStripeReferences({
        references,
        priceId: "price_historical",
      }),
    ).toEqual({
      plan: TENANT_PLAN.STARTER,
      planVersion: 2,
      offerId: historicalOfferId,
      billingInterval: BILLING_INTERVAL.MONTHLY,
    });
    expect(
      getPlanSelectionFromStripeReferences({
        references,
        lookupKey: `shario_${currentOfferId}_starter_monthly`,
      }),
    ).toEqual({
      plan: TENANT_PLAN.STARTER,
      planVersion: 2,
      offerId: currentOfferId,
      billingInterval: BILLING_INTERVAL.MONTHLY,
    });
  });

  it("keeps version-scoped environment aliases attached to the historical offer", () => {
    const references = buildStripePriceReferencesForCommercialCatalog({
      offerCatalog: COMMERCIAL_OFFER_CATALOG,
      currentOfferId: CURRENT_COMMERCIAL_OFFER_ID,
      plan: TENANT_PLAN.STARTER,
      interval: BILLING_INTERVAL.MONTHLY,
      planVersion: 3,
      environment: { STRIPE_STARTER_MONTHLY_V3_PRICE_ID: "price_existing_v3" },
    });
    expect(
      references.find(({ offerId }) => offerId === PLAN_V3_OFFER_ID)?.priceId,
    ).toBe("price_existing_v3");
    expect(
      references.find(({ offerId }) => offerId === INTERNATIONAL_OFFER_ID)
        ?.priceId,
    ).toBeNull();
    expect(
      getPlanSelectionFromStripeReferences({
        references,
        priceId: "price_existing_v3",
      }),
    ).toMatchObject({
      offerId: PLAN_V3_OFFER_ID,
      planVersion: 3,
    });
  });

  it("only returns provisionable specs for current fixed self-serve prices", () => {
    expect(
      getCommercialPriceSpec(
        TENANT_PLAN.PROFESSIONAL,
        BILLING_INTERVAL.MONTHLY,
        3,
      ),
    ).toMatchObject({
      offerId: INTERNATIONAL_OFFER_ID,
      entitlementVersion: 3,
      defaultCurrency: "CZK",
      amounts: { CZK: 199_000, EUR: 7_900 },
      taxBehavior: "exclusive",
    });
    expect(
      getCommercialPriceSpec(
        TENANT_PLAN.PROFESSIONAL,
        BILLING_INTERVAL.MONTHLY,
        2,
      ),
    ).toMatchObject({
      offerId: FOUNDING_OFFER_ID,
      entitlementVersion: 2,
    });
    expect(
      getCommercialPriceSpecForOffer(
        FOUNDING_OFFER_ID,
        TENANT_PLAN.PROFESSIONAL,
        BILLING_INTERVAL.MONTHLY,
        2,
      ),
    ).toMatchObject({
      offerId: FOUNDING_OFFER_ID,
      entitlementVersion: 2,
    });
    expect(
      getCommercialPriceSpec(
        TENANT_PLAN.PROFESSIONAL,
        BILLING_INTERVAL.MONTHLY,
        1,
      ),
    ).toBeNull();
    expect(
      getCommercialPriceSpec(
        TENANT_PLAN.ENTERPRISE,
        BILLING_INTERVAL.MONTHLY,
        3,
      ),
    ).toBeNull();
  });

  it("prefers the current offer and fails when historical resolution is ambiguous", () => {
    const founding = COMMERCIAL_OFFER_CATALOG[FOUNDING_OFFER_ID];
    const current = COMMERCIAL_OFFER_CATALOG[PLAN_V3_OFFER_ID];
    const historicalV3Id = "plans_v3_2025_v1";
    const currentPreferredCatalog = {
      [historicalV3Id]: {
        ...structuredClone(current),
        id: historicalV3Id,
        active: false,
      },
      [PLAN_V3_OFFER_ID]: current,
    } satisfies CommercialOfferCatalog;

    expect(
      getCommercialPriceSpecFromCatalog({
        offerCatalog: currentPreferredCatalog,
        currentOfferId: PLAN_V3_OFFER_ID,
        plan: TENANT_PLAN.STARTER,
        billingInterval: BILLING_INTERVAL.MONTHLY,
        planVersion: 3,
      }),
    ).toMatchObject({ offerId: PLAN_V3_OFFER_ID, entitlementVersion: 3 });

    const otherHistoricalId = "founding_2025_v1";
    const ambiguousHistoricalCatalog = {
      [FOUNDING_OFFER_ID]: founding,
      [otherHistoricalId]: {
        ...structuredClone(founding),
        id: otherHistoricalId,
        active: false,
        founding: false,
      },
      [PLAN_V3_OFFER_ID]: current,
    } satisfies CommercialOfferCatalog;

    expect(() =>
      getCommercialPriceSpecFromCatalog({
        offerCatalog: ambiguousHistoricalCatalog,
        currentOfferId: PLAN_V3_OFFER_ID,
        plan: TENANT_PLAN.STARTER,
        billingInterval: BILLING_INTERVAL.MONTHLY,
        planVersion: 2,
      }),
    ).toThrow(/ambiguous.*founding_2025_v1.*founding_2026_v1/i);
  });

  it("retains historical CZK/EUR offers while publishing approved international currencies for new sales", () => {
    expect(PLATFORM_SUBSCRIPTION_CURRENCIES).toEqual([
      "EUR",
      "USD",
      "CZK",
      "GBP",
      "CHF",
      "PLN",
      "DKK",
      "SEK",
      "NOK",
      "CAD",
      "AUD",
    ]);
    expect(PLATFORM_SUBSCRIPTION_NEW_SALE_CURRENCIES).toEqual([
      "EUR",
      "USD",
      "CZK",
      "GBP",
      "CHF",
      "PLN",
      "DKK",
      "SEK",
      "NOK",
      "CAD",
      "AUD",
    ]);
    expect(
      COMMERCIAL_OFFER_CATALOG[PLAN_V3_OFFER_ID].newSaleCurrencies,
    ).toEqual(["CZK", "EUR"]);
    expect(PLATFORM_SUBSCRIPTION_FALLBACK_CURRENCY).toBe("USD");
  });

  it("exposes the international offer with V3 capabilities through the base API", () => {
    const professional = getBasePlanCatalog().find(
      ({ id }) => id === TENANT_PLAN.PROFESSIONAL,
    );

    expect(professional).toMatchObject({
      id: TENANT_PLAN.PROFESSIONAL,
      version: 3,
      selfServe: true,
      commercial: {
        offerId: INTERNATIONAL_OFFER_ID,
        founding: false,
        displayName: "Professional",
        positioning: "Run your studio.",
        recommended: true,
        saleMode: "self_serve",
        newSaleCurrencies: [
          "EUR",
          "USD",
          "CZK",
          "GBP",
          "CHF",
          "PLN",
          "DKK",
          "SEK",
          "NOK",
          "CAD",
          "AUD",
        ],
        annualSavingsMonths: 2,
      },
      capabilities: {
        ai: { knowledgeHub: true },
        scale: {
          locations: { kind: "fixed", value: 1 },
          teamAccounts: { kind: "fixed", value: 3 },
        },
        operations: {
          firingTracking: false,
          materialsAndInventory: true,
          accessCodeManagement: false,
        },
      },
    });
  });
});
