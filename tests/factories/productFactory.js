import Product from "../../src/models/Product.js";
import { buildCourseProductFixture, buildProductFixture } from "../fixtures/product.fixture.js";

export const productFactory = {
  build: buildProductFixture,
  buildCourse: buildCourseProductFixture,

  async create(overrides = {}) {
    return Product.create(buildProductFixture(overrides));
  },

  async createCourse(overrides = {}) {
    return Product.create(buildCourseProductFixture(overrides));
  },
};
