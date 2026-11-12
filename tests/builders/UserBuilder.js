import { buildUserFixture } from "../fixtures/user.fixture.js";

export class UserBuilder {
  constructor() {
    this.data = buildUserFixture();
  }

  withTenant(tenant) {
    this.data.tenant = tenant?._id || tenant;
    return this;
  }

  admin() {
    this.data.isAdmin = true;
    this.data.roles = ["Admin"];
    return this;
  }

  customer() {
    this.data.isAdmin = false;
    this.data.roles = [];
    return this;
  }

  withEmail(email) {
    this.data.email = email;
    return this;
  }

  withCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  withCredits(amount) {
    this.data.moneyCredits = amount;
    return this;
  }

  withOverrides(overrides = {}) {
    this.data = { ...this.data, ...overrides };
    return this;
  }

  build() {
    return { ...this.data };
  }
}
