import { objectId } from "../helpers/objectId.js";

export function buildOrderFixture(overrides = {}) {
  return {
    _id: overrides._id || objectId(),
    tenant: overrides.tenant || objectId(),
    createdBy: overrides.createdBy || objectId(),
    isPaid: overrides.isPaid ?? true,
    status: overrides.status || "paid",
    courseBookings: overrides.courseBookings || [],
    cart: overrides.cart || undefined,
    totalPrice: overrides.totalPrice ?? 0,
    ...overrides,
  };
}
