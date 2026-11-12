import User from "../../src/models/User.js";
import { buildAdminUserFixture, buildUserFixture } from "../fixtures/user.fixture.js";

export const userFactory = {
  build: buildUserFixture,
  buildAdmin: buildAdminUserFixture,

  async create(overrides = {}) {
    return User.create(buildUserFixture(overrides));
  },

  async createAdmin(overrides = {}) {
    return User.create(buildAdminUserFixture(overrides));
  },
};
