import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TENANT_PLAN, TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { getPlanConfig } from "@/modules/tenants/tenant.plan.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { updateTenantWorkspaceConfigurationSchema } from "@/modules/tenants/settings/tenant-settings.validators.js";
import { createLocationSchema, updateLocationSchema } from "@/modules/location/location.validators.js";
import { createProductSchema, updateProductSchema } from "@/modules/product/product.validators.js";
import { LOCATION_ACTIVITY } from "@/modules/location/location.constants.js";
import { PLANNED_ACTIVITY } from "@/modules/booking/booking.constants.js";
import { PRODUCT_IMPORT_FIELDS } from "@/modules/data-import/data-import.constants.js";
import { MEMBERSHIP_ALLOWANCE_UNIT, MEMBERSHIP_PERCENTAGE_APPLIES_TO } from "@/modules/membership/membership.constants.js";
import { SETUP_STEPS } from "@/modules/setup-center/setup-center.constants.js";

const id = "507f1f77bcf86cd799439011";
const offer = { name: "Shared workspace", type: "service", price: 450, maxNumberOfParticipants: 8 };

describe("Shario generic workspace boundary", () => {
  it("keeps generic API areas and removes pottery implementations and routes", () => {
    const routes = readFileSync(new URL("../../../src/app/routes.ts", import.meta.url), "utf8");
    for (const route of ["bookings", "memberships", "credits", "products", "inventory", "custom-orders", "staff", "communications"]) {
      expect(routes).toContain(`"/${route}"`);
    }
    for (const route of ["kilns", "firings", "pottery-pieces", "piece-pricing-profiles", "firing-profiles", "lost-found"]) {
      expect(routes).not.toContain(`"/${route}"`);
    }
    for (const moduleName of ["kiln", "firing", "pottery-piece", "piece-pricing", "firing-profile", "lost-found"]) {
      expect(existsSync(new URL(`../../../src/modules/${moduleName}`, import.meta.url))).toBe(false);
    }
  });

  it("keeps pottery unavailable in every commercial plan and rejects a stale stored flag", () => {
    for (const version of [1, 2, 3]) for (const plan of Object.values(TENANT_PLAN)) {
      const config = getPlanConfig(plan, version);
      expect(config.modules.firing).toBe(false);
      expect(config.capabilities?.operations?.firingTracking ?? false).toBe(false);
    }
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireTenantModule(TENANT_MODULE.FIRING)({ tenant: { plan: TENANT_PLAN.STUDIO_PLUS, planVersion: 3, modules: { firing: true } } } as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts generic offers and locations while rejecting pottery write policies", () => {
    expect(createProductSchema.safeParse(offer).success).toBe(true);
    expect(createLocationSchema.safeParse({ name: "Shared space", pricingMode: "time" }).success).toBe(true);
    const policy = { registrationPolicy: "required", firingBilling: "separate" };
    for (const studioFlow of [policy, JSON.stringify(policy)]) {
      expect(createProductSchema.safeParse({ ...offer, studioFlow }).success).toBe(false);
      expect(updateProductSchema.safeParse({ id, studioFlow }).success).toBe(false);
    }
    expect(updateLocationSchema.safeParse({ id, firingSettings: { glazingDeadlineDays: 14 } }).success).toBe(false);
    for (const pricingMode of ["piece", "both"]) {
      expect(createLocationSchema.safeParse({ name: "Shared space", pricingMode }).success).toBe(false);
      expect(updateTenantWorkspaceConfigurationSchema.safeParse({ intent: { definitionVersion: 2, pricingMode } }).success).toBe(false);
    }
    expect(updateTenantWorkspaceConfigurationSchema.safeParse({ modules: { firing: true } }).success).toBe(false);
  });

  it("preserves capacity booking, general membership credits, imports and launch setup", () => {
    expect(Object.values(LOCATION_ACTIVITY)).toEqual(["WORKSTATION", "SHARED_TABLE", "GENERAL"]);
    expect(Object.values(PLANNED_ACTIVITY)).toContain("WORKSTATION");
    expect(Object.values(PLANNED_ACTIVITY)).toContain("SHARED_TABLE");
    expect(Object.values(MEMBERSHIP_ALLOWANCE_UNIT)).toEqual(expect.arrayContaining(["credit", "visit", "minute", "hour", "booking"]));
    expect(Object.values(MEMBERSHIP_ALLOWANCE_UNIT)).not.toContain("firing");
    expect(Object.values(MEMBERSHIP_PERCENTAGE_APPLIES_TO)).not.toContain("firings");
    expect(PRODUCT_IMPORT_FIELDS).not.toContain("firingBilling");
    expect(PRODUCT_IMPORT_FIELDS).not.toContain("registrationPolicy");
    expect(SETUP_STEPS).toEqual(expect.arrayContaining(["location", "payments", "bookable_offer", "membership", "inventory", "public_site"]));
    expect(SETUP_STEPS).not.toContain("kilns");
    expect(SETUP_STEPS).not.toContain("piece_pricing");
  });
});
