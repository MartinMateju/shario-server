import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import {
  TENANT_MODULE,
  TENANT_PLAN,
} from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import { reconcileTenantPlanModules } from "@/modules/tenants/tenant-workspace-modules.js";
import type { TenantWorkspaceModules } from "@/modules/tenants/tenant.types.js";

const runAccessGate = (tenant: Record<string, unknown>) => {
  const next = vi.fn();
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };

  requireTenantModule(TENANT_MODULE.ACCESS_CODES)(
    { tenant } as never,
    response as never,
    next,
  );

  return { next, response };
};

describe("legacy Access Code module compatibility", () => {
  it("allows a V2 tenant whose historical record has no Access Code key", () => {
    const { next, response } = runAccessGate({
      plan: TENANT_PLAN.PROFESSIONAL,
      planVersion: 2,
      modules: { ...getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2).modules },
    });

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it("respects an explicit legacy workspace opt-out", () => {
    const { next, response } = runAccessGate({
      plan: TENANT_PLAN.PROFESSIONAL,
      planVersion: 2,
      modules: { ...getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2).modules },
      workspaceModules: { access_codes: { selected: false } },
    });

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("keeps the V3 Starter boundary strict", () => {
    const starter = getPlanConfig(TENANT_PLAN.STARTER, 3);
    const { next, response } = runAccessGate({
      plan: TENANT_PLAN.STARTER,
      planVersion: 3,
      modules: { ...starter.modules },
    });

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("enables Access Codes when a keyless V2 tenant moves to V3 Studio Plus", () => {
    const professional = getPlanConfig(TENANT_PLAN.PROFESSIONAL, 2);
    const workspaceModules: TenantWorkspaceModules = {};
    const tenant = {
      plan: TENANT_PLAN.PROFESSIONAL,
      planVersion: 2,
      modules: { ...professional.modules },
      workspaceModules,
    };

    reconcileTenantPlanModules(
      tenant,
      TENANT_PLAN.STUDIO_PLUS,
      3,
      new Date("2026-08-21T00:00:00.000Z"),
    );

    expect(tenant.workspaceModules.access_codes).toMatchObject({
      selected: true,
    });
    expect(tenant.modules.access_codes).toBe(true);
  });

  it("does not synthesize a false schema default for historical records", () => {
    const schemaSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/modules/tenants/tenant.schema.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const fieldStart = schemaSource.indexOf(
      "[TENANT_MODULE.ACCESS_CODES]: {\n        type: Boolean,",
    );
    const fieldEnd = schemaSource.indexOf("},", fieldStart);

    expect(fieldStart).toBeGreaterThan(-1);
    expect(schemaSource.slice(fieldStart, fieldEnd)).not.toContain("default:");
  });

  it("serializes effective modules from settings and subscription APIs", () => {
    for (const relativePath of [
      "../../../src/modules/tenants/settings/tenant-settings.service.ts",
      "../../../src/modules/tenant-subscription/controllers/tenant-subscription.controller.ts",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );
      expect(source).toContain("deriveEffectiveTenantModules");
      expect(source).toContain("modules: effectiveModules");
    }
  });
});
