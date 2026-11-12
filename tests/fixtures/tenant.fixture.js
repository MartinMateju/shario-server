import { faker } from "@faker-js/faker";
import { objectId } from "../helpers/objectId.js";

export function buildTenantFixture(overrides = {}) {
  const name = overrides.name || faker.company.name();

  return {
    _id: overrides._id || objectId(),
    name,
    slug: overrides.slug || faker.helpers.slugify(name).toLowerCase(),
    isActive: overrides.isActive ?? true,
    plan: overrides.plan || "starter",
    ...overrides,
  };
}
