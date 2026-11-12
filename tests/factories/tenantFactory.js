import { buildTenantFixture } from "../fixtures/tenant.fixture.js";

// If you later create a Tenant model, replace this lightweight factory with Tenant.create(...).
export const tenantFactory = {
  build: buildTenantFixture,
  create: async (overrides = {}) => buildTenantFixture(overrides),
};
