import { faker } from "@faker-js/faker";
import { objectId } from "../helpers/objectId.js";

export function buildUserFixture(overrides = {}) {
  const firstname = overrides.firstname || faker.person.firstName();
  const lastname = overrides.lastname || faker.person.lastName();

  return {
    _id: overrides._id || objectId(),
    tenant: overrides.tenant || objectId(),
    firstname,
    lastname,
    email: overrides.email || faker.internet.email({ firstName: firstname, lastName: lastname }).toLowerCase(),
    password: overrides.password || "$2a$10$testhashedpasswordplaceholder",
    customId: overrides.customId || faker.string.numeric(5),
    roles: overrides.roles || [],
    isAdmin: overrides.isAdmin ?? false,
    moneyCredits: overrides.moneyCredits ?? 0,
    isActive: overrides.isActive ?? true,
    ...overrides,
  };
}

export function buildAdminUserFixture(overrides = {}) {
  return buildUserFixture({
    roles: ["Admin"],
    isAdmin: true,
    ...overrides,
  });
}
