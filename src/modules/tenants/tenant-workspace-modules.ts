import { TENANT_MODULE } from "./tenant.constants.js";
import { getPlanConfig } from "./tenant.plan.js";
import type {
  TenantModuleName,
  TenantModules,
  TenantPlan,
  TenantWorkspaceModules,
} from "./tenant.types.js";

type TenantModuleConfiguration = {
  plan: TenantPlan;
  planVersion: number;
  workspaceModules?: TenantWorkspaceModules;
  legacyModules?: Partial<TenantModules>;
};

export const getTenantModuleEntitlements = ({
  plan,
  planVersion,
}: Pick<TenantModuleConfiguration, "plan" | "planVersion">): TenantModules => {
  const modules = getPlanConfig(plan, planVersion).modules;

  // Access Codes predate their dedicated Plan V3 entitlement. Keep the
  // historical runtime behavior outside the immutable V1/V2 snapshots.
  if (planVersion < 3 && modules[TENANT_MODULE.ACCESS_CODES] === undefined) {
    return { ...modules, [TENANT_MODULE.ACCESS_CODES]: true };
  }

  return modules;
};

export const isWorkspaceModuleSelected = (
  workspaceModules: TenantWorkspaceModules | undefined,
  moduleName: TenantModuleName,
  fallback = true,
): boolean => moduleName !== TENANT_MODULE.FIRING && (workspaceModules?.[moduleName]?.selected ?? fallback);

export const getLegacyWorkspaceModuleSelection = ({
  entitlements,
  modules,
  moduleName,
}: {
  entitlements: TenantModules;
  modules?: Partial<TenantModules>;
  moduleName: TenantModuleName;
}): boolean => {
  if (moduleName === TENANT_MODULE.FIRING) return false;
  if (!entitlements[moduleName]) return true;
  return modules?.[moduleName] !== false;
};

export const materializeWorkspaceModuleSelections = ({
  entitlements,
  modules,
  workspaceModules,
}: {
  entitlements: TenantModules;
  modules?: Partial<TenantModules>;
  workspaceModules?: TenantWorkspaceModules;
}): TenantWorkspaceModules =>
  Object.values(TENANT_MODULE).reduce<TenantWorkspaceModules>(
    (selection, moduleName) => {
      const current = workspaceModules?.[moduleName];
      if (current) {
        selection[moduleName] = {
          selected: current.selected,
          ...(current.enabledAt ? { enabledAt: current.enabledAt } : {}),
          ...(current.disabledAt ? { disabledAt: current.disabledAt } : {}),
          ...(current.lastUsedAt ? { lastUsedAt: current.lastUsedAt } : {}),
        };
      } else if (entitlements[moduleName] || modules?.[moduleName] === true) {
        // Legacy tenants stored the effective flag only. Materialize that
        // value before changing plans so an explicit off choice is retained.
        selection[moduleName] = {
          selected: getLegacyWorkspaceModuleSelection({
            entitlements,
            modules,
            moduleName,
          }),
        };
      }
      return selection;
    },
    {},
  );

export const setWorkspaceModuleSelection = ({
  workspaceModules,
  moduleName,
  selected,
  currentSelected,
  now = new Date(),
}: {
  workspaceModules: TenantWorkspaceModules;
  moduleName: TenantModuleName;
  selected: boolean;
  currentSelected: boolean;
  now?: Date;
}): void => {
  const current = workspaceModules[moduleName];
  if (current?.selected === selected) return;

  if (!current && currentSelected === selected) {
    // Materializing a legacy/default value is not a transition, so do not
    // invent an enable/disable timestamp.
    workspaceModules[moduleName] = { selected };
    return;
  }

  workspaceModules[moduleName] = {
    ...(current ?? {}),
    selected,
    ...(selected ? { enabledAt: now } : { disabledAt: now }),
  };
};

export const deriveEffectiveTenantModules = ({
  plan,
  planVersion,
  workspaceModules,
  legacyModules,
}: TenantModuleConfiguration): TenantModules => {
  const entitlements = getTenantModuleEntitlements({ plan, planVersion });

  const modules = Object.values(TENANT_MODULE).reduce<TenantModules>(
    (modules, moduleName) => {
      modules[moduleName] =
        entitlements[moduleName] === true &&
        isWorkspaceModuleSelected(
          workspaceModules,
          moduleName,
          legacyModules?.[moduleName] !== false,
        );
      return modules;
    },
    {} as TenantModules,
  );

  // Automations keep their independent owner selection but cannot execute
  // without the communications capability they deliver through.
  if (!modules[TENANT_MODULE.COMMUNICATIONS]) {
    modules[TENANT_MODULE.AUTOMATIONS] = false;
  }

  return modules;
};

export const refreshEffectiveTenantModules = <
  T extends {
    plan: TenantPlan;
    planVersion: number;
    modules: TenantModules;
    workspaceModules?: TenantWorkspaceModules;
  },
>(
  tenant: T,
): T => {
  const legacyModules = tenant.modules;
  tenant.modules = deriveEffectiveTenantModules({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
    workspaceModules: tenant.workspaceModules,
    legacyModules,
  });
  return tenant;
};

export const reconcileTenantPlanModules = <
  T extends {
    plan: TenantPlan;
    planVersion: number;
    modules: TenantModules;
    workspaceModules?: TenantWorkspaceModules;
  },
>(
  tenant: T,
  plan: TenantPlan,
  planVersion: number,
  now = new Date(),
): T => {
  const currentEntitlements = getTenantModuleEntitlements({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
  });
  const workspaceModules = materializeWorkspaceModuleSelections({
    entitlements: currentEntitlements,
    modules: tenant.modules,
    workspaceModules: tenant.workspaceModules,
  });
  const nextEntitlements = getTenantModuleEntitlements({ plan, planVersion });

  for (const moduleName of Object.values(TENANT_MODULE)) {
    if (nextEntitlements[moduleName] && !workspaceModules[moduleName]) {
      // Newly entitled capabilities are all-inclusive by default. Owners may
      // opt out later without losing any underlying domain data.
      workspaceModules[moduleName] = { selected: true, enabledAt: now };
    }
  }

  tenant.plan = plan;
  tenant.planVersion = planVersion;
  tenant.workspaceModules = workspaceModules;
  tenant.modules = deriveEffectiveTenantModules({
    plan,
    planVersion,
    workspaceModules,
  });
  return tenant;
};
