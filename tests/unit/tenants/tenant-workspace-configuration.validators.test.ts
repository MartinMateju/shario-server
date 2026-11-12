import { describe, expect, it } from "vitest";

import { updateTenantWorkspaceConfigurationSchema } from "@/modules/tenants/settings/tenant-settings.validators.js";
import { TENANT_WORKSPACE_INTENT_DEFINITION_VERSION } from "@/modules/tenants/tenant.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";

const completeModules = {
  bookings: true,
  payments: true,
  customers: true,
  courses: false,
  memberships: false,
  credits: false,
  vouchers: false,
  access_codes: false,
  automations: false,
  newsletter: false,
  firing: false,
  inventory: true,
  staff_tasks: false,
  communications: false,
  ai: false,
};

const completeAnswers = {
  sharedStudio: true,
  classes: false,
  firingServices: false,
  memberships: false,
  vouchers: true,
  inventory: false,
};

describe("workspace configuration validation", () => {
  it("accepts and persists hiding and restoring the Custom orders navigation item", async () => {
    const input = updateTenantWorkspaceConfigurationSchema.parse({
      navigation: { hiddenItems: ["customOrders", "customOrders"] },
    });
    expect(input.navigation.hiddenItems).toEqual(["customOrders"]);
    const tenant = new TenantModel({
      name: "Custom orders navigation",
      slug: "custom-orders-navigation",
      settings: { navigation: input.navigation },
    });
    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(tenant.toObject().settings.navigation.hiddenItems).toEqual([
      "customOrders",
    ]);
    const restored = updateTenantWorkspaceConfigurationSchema.parse({
      navigation: { hiddenItems: [] },
    });
    tenant.settings.navigation.hiddenItems = restored.navigation.hiddenItems;
    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(tenant.toObject().settings.navigation.hiddenItems).toEqual([]);
  });

  it("keeps unsupported navigation keys rejected by both API and stored schema", async () => {
    const navigation = { hiddenItems: ["custom-orders"] };
    expect(
      updateTenantWorkspaceConfigurationSchema.safeParse({ navigation })
        .success,
    ).toBe(false);
    const tenant = new TenantModel({
      name: "Invalid navigation",
      slug: "invalid-custom-orders-navigation",
      settings: { navigation },
    });
    await expect(tenant.validate()).rejects.toThrow("not a valid enum value");
  });

  it("accepts partial module choices and deduplicates navigation keys", () => {
    expect(
      updateTenantWorkspaceConfigurationSchema.parse({
        modules: { bookings: false, access_codes: true },
        navigation: {
          hiddenGroups: ["bookings", "bookings"],
          hiddenItems: ["reports", "reports"],
        },
      }),
    ).toEqual({
      modules: { bookings: false, access_codes: true },
      navigation: {
        hiddenGroups: ["bookings"],
        hiddenItems: ["reports"],
      },
    });
  });

  it("accepts only a versioned, complete module map as workspace intent", () => {
    expect(
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
        },
      }),
    ).toEqual({
      intent: {
        definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
        modules: completeModules,
      },
    });

    const { access_codes: _accessCodes, ...legacyClientModules } =
      completeModules;
    expect(
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: legacyClientModules,
        },
      }),
    ).toMatchObject({ intent: { modules: legacyClientModules } });

    const { ai: _ai, ...incompleteModules } = completeModules;
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: incompleteModules,
        },
      }),
    ).toThrow();
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        modules: { bookings: false },
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
        },
      }),
    ).toThrow();
  });

  it("accepts an optional, complete questionnaire answer map", () => {
    expect(
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
          answers: completeAnswers,
        },
      }),
    ).toEqual({
      intent: {
        definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
        modules: completeModules,
        answers: completeAnswers,
      },
    });

    const { inventory: _inventory, ...incompleteAnswers } = completeAnswers;
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
          answers: incompleteAnswers,
        },
      }),
    ).toThrow();
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
          answers: { ...completeAnswers, imaginaryWorkflow: true },
        },
      }),
    ).toThrow();
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
          modules: completeModules,
          answers: { ...completeAnswers, classes: "yes" },
        },
      }),
    ).toThrow();
  });

  it.each(["time"])(
    "accepts checklist-only v2 %s intent without module choices",
    (pricingMode) => {
      const { firingServices: _legacy, ...answers } = completeAnswers;
      expect(
        updateTenantWorkspaceConfigurationSchema.parse({
          intent: { definitionVersion: 2, pricingMode, answers },
        }),
      ).toEqual({ intent: { definitionVersion: 2, pricingMode, answers } });
      expect(() =>
        updateTenantWorkspaceConfigurationSchema.parse({
          intent: { definitionVersion: 2, pricingMode: "hourly" },
        }),
      ).toThrow();
    },
  );

  it("still accepts old version-one questionnaire payloads", () => {
    expect(
      updateTenantWorkspaceConfigurationSchema.parse({
        intent: {
          definitionVersion: 1,
          modules: completeModules,
          answers: completeAnswers,
        },
      }),
    ).toMatchObject({
      intent: { definitionVersion: 1, answers: completeAnswers },
    });
  });

  it("rejects protected and ambiguous navigation anchors", () => {
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        navigation: { hiddenItems: ["overview"] },
      }),
    ).toThrow();
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        navigation: { hiddenGroups: ["reports"] },
      }),
    ).toThrow();
  });

  it("rejects unknown module keys and empty patches", () => {
    expect(() =>
      updateTenantWorkspaceConfigurationSchema.parse({
        modules: { imaginary: true },
      }),
    ).toThrow();
    expect(() => updateTenantWorkspaceConfigurationSchema.parse({})).toThrow();
  });
});
