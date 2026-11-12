import { describe, expect, it, vi } from "vitest";

import { requireAnyTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { TENANT_MODULE, TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";

const response = () => {
  const json = vi.fn();
  return {
    status: vi.fn(() => ({ json })),
    json,
  };
};

describe("requireAnyTenantModule", () => {
  it("allows a courses workflow when bookings is disabled", () => {
    const next = vi.fn();
    const res = response();
    requireAnyTenantModule([TENANT_MODULE.BOOKINGS, TENANT_MODULE.COURSES])(
      {
        tenant: {
          plan: TENANT_PLAN.PROFESSIONAL,
          planVersion: 1,
          modules: { bookings: false, courses: true },
        },
      } as any,
      res as any,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns a disabled error when an entitled option is selected off", () => {
    const next = vi.fn();
    const res = response();
    requireAnyTenantModule([TENANT_MODULE.BOOKINGS, TENANT_MODULE.COURSES])(
      {
        tenant: {
          plan: TENANT_PLAN.STARTER,
          planVersion: 1,
          modules: { bookings: false, courses: false },
        },
      } as any,
      res as any,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TENANT_MODULE_DISABLED" }),
    );
  });
});
