import Order from "../../src/models/Order.js";
import { buildOrderFixture } from "../fixtures/order.fixture.js";

export const orderFactory = {
  build: buildOrderFixture,

  async create(overrides = {}) {
    return Order.create(buildOrderFixture(overrides));
  },
};
