import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Location from "@/modules/location/location.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import User from "@/modules/user/user.model.js";
import CustomRole from "@/modules/tenant-access/tenant-custom-role.model.js";
import Membership from "@/modules/tenant-access/tenant-membership.model.js";
import { workspaceAccessCacheKey } from "@/modules/tenant-access/tenant-access.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { updateTeamMemberSchema } from "@/modules/tenant-access/tenant-access.validators.js";
import { resolveWorkspaceAccessForUser } from "@/modules/tenant-access/services/authorization.service.js";
import { updateTeamMember } from "@/modules/tenant-access/services/team.service.js";

const cache = vi.hoisted(() => ({ deleteCache: vi.fn() }));
vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: cache.deleteCache,
}));

let replica: MongoMemoryReplSet;

const seedTeam = async () => {
  const tenant = await Tenant.create({
    name: "Role editing studio",
    slug: "role-editing",
    status: "active",
    plan: "studio_plus",
    planVersion: 3,
    limits: { staffMembers: 10, admins: 10 },
  });
  const tenantId = String(tenant._id);
  const actorUserId = String(new mongoose.Types.ObjectId());
  const userId = String(new mongoose.Types.ObjectId());
  await User.collection.insertMany(
    [actorUserId, userId].map((id, index) => ({
      _id: new mongoose.Types.ObjectId(id),
      tenant: tenant._id,
      customId: `ROLE-TEST-${id}`,
      email: index ? "member@example.test" : "owner@example.test",
      firstname: index ? "Existing" : "Owner",
      lastname: "Person",
      password: "unchanged-password-hash",
      tenantRole: index ? "staff" : "owner",
      platformRole: "none",
      isAccessGranted: true,
      isEmailVerified: true,
      memberNumber: index + 1,
      memberNumberHistory: [],
      refreshToken: index ? ["existing-session"] : [],
      sessionVersion: 0,
      moneyCredits: 75,
      moneyCreditsMinor: 7500,
    })),
  );
  await Membership.create({
    tenant: tenantId,
    user: actorUserId,
    role: "owner",
    status: "active",
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });
  const location = await Location.create({
    tenant: tenantId,
    name: "Selected studio",
    slug: "selected-studio",
    code: "SELECTED",
  });
  const workspaceProfile = {
    displayName: "Existing teammate",
    jobTitle: "Studio manager",
    calendarColor: "#aabbcc",
  };
  const locationAccess = {
    mode: "selected" as const,
    locationIds: [String(location._id)],
  };
  const membership = await Membership.create({
    tenant: tenantId,
    user: userId,
    role: "viewer",
    status: "active",
    locationAccess,
    workspaceProfile,
    preferences: { language: "cs", defaultLocation: location._id },
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });
  const actorAccess = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: actorUserId,
  });
  return {
    tenantId,
    actorUserId,
    actorAccess: actorAccess!,
    userId,
    membershipId: String(membership._id),
    workspaceProfile,
    locationAccess,
  };
};

describe("existing team member role updates with real tenant transactions", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri("team-member-roles-test"));
    await Promise.all(
      [Tenant, User, Location, Membership, CustomRole].map((model) =>
        model.init(),
      ),
    );
  }, 60_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  beforeEach(async () => {
    cache.deleteCache.mockReset().mockResolvedValue(undefined);
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(
      collections.map((collection) => collection.deleteMany({})),
    );
  });

  it("promotes and demotes the same account while preserving its location and profile", async () => {
    const context = await seedTeam();
    const originalUser = await User.findById(context.userId)
      .select("+password")
      .lean();
    const initial = await resolveWorkspaceAccessForUser(context);
    expect(initial!.permissions).not.toContain(
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    );

    const promoted = await updateTeamMember({
      ...context,
      input: updateTeamMemberSchema.parse({ roleKey: "manager" }),
    });
    expect(promoted).toMatchObject({
      membershipId: context.membershipId,
      roleKey: "manager",
      customRoleId: null,
      status: "active",
      locationAccess: context.locationAccess,
      workspaceProfile: context.workspaceProfile,
      preferences: {
        language: "cs",
        defaultLocation: context.locationAccess.locationIds[0],
      },
    });
    const managerAccess = await resolveWorkspaceAccessForUser(context);
    expect(managerAccess!.permissions).toContain(
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    );
    expect(managerAccess!.accessVersion).toBe(initial!.accessVersion + 1);
    expect(cache.deleteCache).toHaveBeenCalledWith(
      workspaceAccessCacheKey(context.tenantId, context.userId),
    );
    expect(
      (await User.findById(context.userId).select("+refreshToken").lean())!
        .refreshToken,
    ).toEqual([]);

    await updateTeamMember({
      ...context,
      input: updateTeamMemberSchema.parse({ roleKey: "viewer" }),
    });
    const viewerAccess = await resolveWorkspaceAccessForUser(context);
    expect(viewerAccess).toMatchObject({
      membershipId: context.membershipId,
      role: "viewer",
      accessVersion: managerAccess!.accessVersion + 1,
      locationAccess: context.locationAccess,
      workspaceProfile: context.workspaceProfile,
    });
    expect(viewerAccess!.permissions).not.toContain(
      WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
    );
    const after = await User.findById(context.userId)
      .select("+password")
      .lean();
    expect(after).toMatchObject({
      _id: originalUser!._id,
      email: originalUser!.email,
      firstname: originalUser!.firstname,
      lastname: originalUser!.lastname,
      password: originalUser!.password,
      moneyCredits: originalUser!.moneyCredits,
      moneyCreditsMinor: originalUser!.moneyCreditsMinor,
    });
    expect(
      await Membership.countDocuments({
        tenant: context.tenantId,
        user: context.userId,
      }),
    ).toBe(1);
  });

  it("applies custom role replacements and clears custom grants when returning to a built-in role", async () => {
    const context = await seedTeam();
    const [bookingsRole, inventoryRole] = await CustomRole.create(
      [
        {
          name: "Bookings only",
          permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
        },
        {
          name: "Inventory only",
          permissions: [WORKSPACE_PERMISSION.INVENTORY_MANAGE],
        },
      ].map((role) => ({
        ...role,
        normalizedName: role.name.toLowerCase(),
        tenant: context.tenantId,
        createdBy: context.actorUserId,
        updatedBy: context.actorUserId,
      })),
    );
    for (const role of [bookingsRole, inventoryRole]) {
      const updated = await updateTeamMember({
        ...context,
        input: updateTeamMemberSchema.parse({
          roleKey: "custom",
          customRoleId: String(role._id),
        }),
      });
      expect(updated).toMatchObject({
        membershipId: context.membershipId,
        roleKey: "custom",
        customRoleId: String(role._id),
        roleName: role.name,
        locationAccess: context.locationAccess,
        workspaceProfile: context.workspaceProfile,
      });
      const access = await resolveWorkspaceAccessForUser(context);
      expect(access!.permissions).toEqual(role.permissions);
      expect(access!.customRoleId).toBe(String(role._id));
    }

    const updated = await updateTeamMember({
      ...context,
      input: updateTeamMemberSchema.parse({ roleKey: "viewer" }),
    });
    expect(updated).toMatchObject({
      membershipId: context.membershipId,
      roleKey: "viewer",
      customRoleId: null,
    });
    const access = await resolveWorkspaceAccessForUser(context);
    expect(access!.customRoleId).toBeNull();
    expect(access!.permissions).toContain(WORKSPACE_PERMISSION.BOOKINGS_VIEW);
    expect(access!.permissions).not.toContain(
      WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    );
  });
});
