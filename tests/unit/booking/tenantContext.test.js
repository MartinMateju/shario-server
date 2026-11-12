import { describe, expect, it } from "vitest";

import {
  getTenantIdFromRequest,
  requireTenantId,
} from "../../../src/modules/tenants/tenant.utils.js";

const TENANT_A = "507f1f77bcf86cd799439011";
const TENANT_B = "507f191e810c19729de860ea";

describe("tenantContext", () => {
  it("resolves tenant id from req.tenantId", () => {
    expect(getTenantIdFromRequest({ tenantId: TENANT_A })).toBe(TENANT_A);
  });

  it("resolves tenant id from req.userInfo.tenantId", () => {
    expect(
      getTenantIdFromRequest({ userInfo: { tenantId: TENANT_B } }),
    ).toBe(TENANT_B);
  });

  it("throws when tenant id is missing", () => {
    expect(() => requireTenantId({})).toThrow(
      "Authenticated tenant is missing from the access token.",
    );
  });
});
