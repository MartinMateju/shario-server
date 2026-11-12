import { faker } from "@faker-js/faker";
import { objectId } from "../helpers/objectId.js";

export function buildProductFixture(overrides = {}) {
  return {
    _id: overrides._id || objectId(),
    tenant: overrides.tenant || objectId(),
    name: overrides.name || faker.commerce.productName(),
    type: overrides.type || "workshop",
    price: overrides.price ?? 150,
    extraCharge: overrides.extraCharge ?? 0,
    maxNumberOfParticipants: overrides.maxNumberOfParticipants ?? 8,
    isActive: overrides.isActive ?? true,
    ...overrides,
  };
}

export function buildCourseProductFixture(overrides = {}) {
  return buildProductFixture({
    type: "course",
    price: 1000,
    maxNumberOfParticipants: 8,
    ...overrides,
  });
}
