import { describe, expect, it } from "vitest";

import {
  TENANT_MODULE,
  TENANT_PLAN,
} from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import type {
  TenantModules,
  TenantPlan,
  TenantWorkspaceModules,
} from "@/modules/tenants/tenant.types.js";
import {
  deriveEffectiveTenantModules,
  getTenantModuleEntitlements,
  materializeWorkspaceModuleSelections,
  reconcileTenantPlanModules,
  setWorkspaceModuleSelection,
} from "@/modules/tenants/tenant-workspace-modules.js";

const tenantFor = (
  plan: TenantPlan,
): {
  plan: TenantPlan;
  planVersion: number;
  modules: TenantModules;
  workspaceModules: TenantWorkspaceModules;
} => {
  const config = getPlanConfig(plan);
  return {
    plan,
    planVersion: config.version,
    modules: { ...config.modules },
    workspaceModules: {},
  };
};

describe("tenant workspace module reconciliation", () => {
  it("keeps an explicit opt-out through an upgrade", () => {
    const tenant = tenantFor(TENANT_PLAN.STARTER);
    tenant.workspaceModules = { bookings: { selected: false } };

    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL);
    reconcileTenantPlanModules(
      tenant,
      TENANT_PLAN.PROFESSIONAL,
      professional.version,
    );

    expect(tenant.workspaceModules.bookings?.selected).toBe(false);
    expect(tenant.modules.bookings).toBe(false);
    expect(tenant.workspaceModules.memberships?.selected).toBe(true);
    expect(tenant.modules.memberships).toBe(true);
  });

  it("retains selection across a downgrade and restores it on re-upgrade", () => {
    const tenant = tenantFor(TENANT_PLAN.PROFESSIONAL);
    const starter = getPlanConfig(TENANT_PLAN.STARTER);
    reconcileTenantPlanModules(tenant, TENANT_PLAN.STARTER, starter.version);

    expect(tenant.workspaceModules.memberships?.selected).toBe(true);
    expect(tenant.modules.memberships).toBe(false);

    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL);
    reconcileTenantPlanModules(
      tenant,
      TENANT_PLAN.PROFESSIONAL,
      professional.version,
    );
    expect(tenant.workspaceModules.memberships?.selected).toBe(true);
    expect(tenant.modules.memberships).toBe(true);
  });

  it("preserves anomalous legacy true flags outside the old entitlement", () => {
    const tenant = tenantFor(TENANT_PLAN.STARTER);
    tenant.modules.inventory = true;

    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL);
    reconcileTenantPlanModules(
      tenant,
      TENANT_PLAN.PROFESSIONAL,
      professional.version,
    );
    expect(tenant.workspaceModules.inventory).toMatchObject({ selected: true });
    expect(tenant.modules.inventory).toBe(true);
  });

  it("preserves legacy access-code access while applying the V3 boundary", () => {
    expect(getPlanConfig(TENANT_PLAN.STARTER, 1).modules.access_codes).toBe(
      undefined,
    );
    expect(getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2).modules.access_codes).toBe(
      undefined,
    );
    expect(
      getTenantModuleEntitlements({
        plan: TENANT_PLAN.PROFESSIONAL,
        planVersion: 2,
      }).access_codes,
    ).toBe(true);
    expect(
      getPlanConfig(TENANT_PLAN.PROFESSIONAL, 3).modules.access_codes,
    ).toBe(false);
    expect(getPlanConfig(TENANT_PLAN.STUDIO_PLUS, 3).modules.access_codes).toBe(
      true,
    );
  });

  it("always derives a complete effective boolean map", () => {
    const effective = deriveEffectiveTenantModules({
      plan: TENANT_PLAN.STARTER,
      planVersion: 1,
      workspaceModules: { bookings: { selected: false } },
      legacyModules: { inventory: false },
    });

    expect(Object.keys(effective).sort()).toEqual(
      Object.values(TENANT_MODULE).sort(),
    );
    expect(effective.bookings).toBe(false);
    expect(effective.inventory).toBe(false);
  });

  it("does not reset transition timestamps on an idempotent selection", () => {
    const disabledAt = new Date("2026-07-30T12:00:00.000Z");
    const workspaceModules = {
      bookings: { selected: false, disabledAt },
    };

    setWorkspaceModuleSelection({
      workspaceModules,
      moduleName: TENANT_MODULE.BOOKINGS,
      selected: false,
      currentSelected: false,
      now: new Date("2026-07-31T12:00:00.000Z"),
    });
    expect(workspaceModules.bookings.disabledAt).toBe(disabledAt);
  });

  it("preserves automation intent while communications is off", () => {
    const tenant = tenantFor(TENANT_PLAN.PROFESSIONAL);
    tenant.workspaceModules = {
      automations: { selected: true },
      communications: { selected: false },
    };

    let effective = deriveEffectiveTenantModules({
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      workspaceModules: tenant.workspaceModules,
    });
    expect(tenant.workspaceModules.automations?.selected).toBe(true);
    expect(effective.automations).toBe(false);

    setWorkspaceModuleSelection({
      workspaceModules: tenant.workspaceModules,
      moduleName: TENANT_MODULE.COMMUNICATIONS,
      selected: true,
      currentSelected: false,
    });
    effective = deriveEffectiveTenantModules({
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      workspaceModules: tenant.workspaceModules,
    });
    expect(tenant.workspaceModules.automations?.selected).toBe(true);
    expect(effective.automations).toBe(true);
  });

  it("preserves legacy communications and automation opt-outs", () => {
    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL);
    const modules = {
      ...professional.modules,
      communications: false,
      automations: false,
    };
    const selection = materializeWorkspaceModuleSelections({
      entitlements: professional.modules,
      modules,
    });
    expect(selection.communications?.selected).toBe(false);
    expect(selection.automations?.selected).toBe(false);
  });
});
