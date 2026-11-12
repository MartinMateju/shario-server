import mongoose from "mongoose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import TenantModel from "../../../src/modules/tenants/tenant.model.js";
import UserModel from "../../../src/modules/user/user.model.js";
import TenantCustomRoleModel from "../../../src/modules/tenant-access/tenant-custom-role.model.js";
import TenantMembershipModel from "../../../src/modules/tenant-access/tenant-membership.model.js";
import { resolveWorkspaceAccessForUser } from "../../../src/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "../../../src/modules/tenant-access/tenant-access.permissions.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const describeMongoIntegration =
  process.env.RUN_MONGO_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/*
 * MongoMemoryServer requires a compatible mongod binary on the host. Keep the
 * integration suite opt-in so normal unit CI remains deterministic; dedicated
 * integration CI should set RUN_MONGO_INTEGRATION_TESTS=true.
 */
describeMongoIntegration("tenant access resolution", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await Promise.all([
      TenantMembershipModel.syncIndexes(),
      TenantCustomRoleModel.syncIndexes(),
    ]);
  });
  beforeEach(clearTestDatabase);
  afterAll(disconnectTestDatabase);

  it("resolves custom permissions only inside the membership tenant", async () => {
    const [tenantA, tenantB] = await TenantModel.create([
      { name: "Studio A", slug: "studio-a" },
      { name: "Studio B", slug: "studio-b" },
    ]);
    const user = await UserModel.create({
      tenant: tenantA._id,
      firstname: "Team",
      lastname: "Member",
      email: "team@example.com",
      password: "safe-password-123",
      customId: "U-TEAM-1",
      tenantRole: "staff",
    });
    const role = await TenantCustomRoleModel.create({
      tenant: tenantA._id,
      name: "Calendar operator",
      normalizedName: "calendar operator",
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
      createdBy: user._id,
      updatedBy: user._id,
    });
    await TenantMembershipModel.create({
      tenant: tenantA._id,
      user: user._id,
      status: "active",
      role: "custom",
      customRole: role._id,
      createdBy: user._id,
      updatedBy: user._id,
    });

    const accessA = await resolveWorkspaceAccessForUser({
      tenantId: String(tenantA._id),
      userId: String(user._id),
    });
    const accessB = await resolveWorkspaceAccessForUser({
      tenantId: String(tenantB._id),
      userId: String(user._id),
    });

    expect(accessA?.customRoleName).toBe("Calendar operator");
    expect(accessA?.permissions).toEqual([
      WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    ]);
    expect(accessB).toBeNull();
  });

  it("returns no effective permissions for a suspended membership", async () => {
    const tenant = await TenantModel.create({
      name: "Studio Suspended",
      slug: "studio-suspended",
    });
    const userId = new mongoose.Types.ObjectId();
    await TenantMembershipModel.create({
      tenant: tenant._id,
      user: userId,
      status: "suspended",
      role: "admin",
      createdBy: userId,
      updatedBy: userId,
    });

    const access = await resolveWorkspaceAccessForUser({
      tenantId: String(tenant._id),
      userId: String(userId),
    });

    expect(access?.status).toBe("suspended");
    expect(access?.permissions).toEqual([]);
  });
});
