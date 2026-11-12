import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Tenant from "@/modules/tenants/tenant.model.js";
import type { TenantPlan } from "@/modules/tenants/tenant.types.js";
import Location from "@/modules/location/location.model.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { locationService } from "@/modules/location/services/location.service.js";
import { createLocationSchema } from "@/modules/location/location.validators.js";
import Membership from "@/modules/tenant-access/tenant-membership.model.js";
import CustomRole from "@/modules/tenant-access/tenant-custom-role.model.js";
import { resolveWorkspaceAccessForUser } from "@/modules/tenant-access/services/authorization.service.js";
import {
  createWorkspaceCustomRole,
  listWorkspaceRoles,
  updateWorkspaceCustomRole,
} from "@/modules/tenant-access/services/role.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { InventoryItem } from "@/modules/inventory/inventory.model.js";
import { inventoryRepository } from "@/modules/inventory/inventory.repository.js";
import { inventoryService } from "@/modules/inventory/services/inventory.service.js";
import { createInventoryItemSchema } from "@/modules/inventory/inventory.validators.js";

vi.mock("@/infrastructure/redis/cache.js", () => ({
  deleteCache: vi.fn().mockResolvedValue(undefined),
  deleteCacheKeys: vi.fn().mockResolvedValue(undefined),
}));

let replica: MongoMemoryReplSet;
const models = [Tenant, Location, Membership, CustomRole, InventoryItem];
const actorId = new mongoose.Types.ObjectId();
const locationInput = (name: string) => createLocationSchema.parse({ name });

const seedTenant = async (
  plan: TenantPlan = "studio_plus",
  planVersion = 3,
  limit = 2,
) => {
  const tenant = await Tenant.create({
    name: "Plan admissions studio",
    slug: "plan-admissions-studio",
    plan,
    planVersion,
    limits: { locations: limit },
  });
  return String(tenant._id);
};

const seedOwner = async (tenantId: string) => {
  await Membership.create({
    tenant: tenantId,
    user: actorId,
    role: "owner",
    status: "active",
    createdBy: actorId,
    updatedBy: actorId,
  });
  const actorAccess = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: String(actorId),
  });
  if (!actorAccess) throw new Error("Owner fixture was not created.");
  return { tenantId, actorUserId: String(actorId), actorAccess };
};

const createRole = (context: Awaited<ReturnType<typeof seedOwner>>) =>
  createWorkspaceCustomRole({
    ...context,
    input: {
      name: "Calendar operator",
      description: "",
      permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW],
    },
  });

describe("tenant plan admissions with MongoDB transactions", () => {
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all(models.map((model) => model.init()));
  }, 60_000);
  beforeEach(async () => {
    await Promise.all(models.map((model) => model.collection.deleteMany({})));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });

  it("serializes concurrent creation and reactivation at a finite inventory quota", async () => {
    const tenantId = await seedTenant("professional", 2);
    await Tenant.updateOne(
      { _id: tenantId },
      { $set: { "limits.inventoryItems": 1 } },
    );
    const location = await locationService.create(
      tenantId,
      locationInput("Primary"),
    );
    const input = (name: string, isActive = true) =>
      createInventoryItemSchema.parse({
        name,
        isActive,
        stockLevels: [
          {
            location: String(location._id),
            currentQuantity: 0,
            minimumQuantity: 0,
          },
        ],
      });
    const archived = await inventoryService.createItem(
      tenantId,
      String(actorId),
      input("Archived", false),
    );
    const original =
      inventoryRepository.countActiveItems.bind(inventoryRepository);
    vi.spyOn(inventoryRepository, "countActiveItems").mockImplementation(
      async (...args) => {
        const count = await original(...args);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return count;
      },
    );
    const outcomes = await Promise.allSettled([
      inventoryService.createItem(tenantId, String(actorId), input("New")),
      inventoryService.updateItem(
        tenantId,
        String(archived!._id),
        String(actorId),
        { isActive: true },
      ),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({
      reason: { code: "INVENTORY_ITEM_LIMIT_REACHED" },
    });
    expect(
      await InventoryItem.countDocuments({ tenant: tenantId, isActive: true }),
    ).toBe(1);
  });

  it("honors a stored zero inventory allowance", async () => {
    const tenantId = await seedTenant("starter");
    const location = await locationService.create(
      tenantId,
      locationInput("Primary"),
    );
    await expect(
      inventoryService.createItem(
        tenantId,
        String(actorId),
        createInventoryItemSchema.parse({
          name: "No allowance",
          stockLevels: [
            {
              location: String(location._id),
              currentQuantity: 0,
              minimumQuantity: 0,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "INVENTORY_ITEM_LIMIT_REACHED",
      details: { inventoryItemLimit: 0 },
    });
  });

  it.each(["create", "activate", "mixed"] as const)(
    "admits only one of two concurrent location requests (%s) at the remaining quota",
    async (mode) => {
      const tenantId = await seedTenant();
      await locationService.create(tenantId, locationInput("Primary"));
      const archived = await Location.create([
        { tenant: tenantId, ...locationInput("Archived one"), isActive: false },
        { tenant: tenantId, ...locationInput("Archived two"), isActive: false },
      ]);
      const originalCount =
        locationRepository.countActive.bind(locationRepository);
      // Widen the vulnerable read/write window. A tenant lock must serialize
      // these admissions even while the first capacity read is held open.
      vi.spyOn(locationRepository, "countActive").mockImplementation(
        async (...args) => {
          const count = await originalCount(...args);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return count;
        },
      );
      const outcomes = await Promise.allSettled([
        mode === "activate"
          ? locationService.activate(tenantId, String(archived[0]._id))
          : locationService.create(tenantId, locationInput("New one")),
        mode === "create"
          ? locationService.create(tenantId, locationInput("New two"))
          : locationService.activate(tenantId, String(archived[1]._id)),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.find((outcome) => outcome.status === "rejected"),
      ).toMatchObject({
        reason: { statusCode: 409, code: "LOCATION_LIMIT_REACHED" },
      });
      expect(
        await Location.countDocuments({ tenant: tenantId, isActive: true }),
      ).toBe(2);
    },
  );

  it("honors a stored Professional location override instead of resetting it to the catalog", async () => {
    const tenantId = await seedTenant("professional", 3, 2);
    await locationService.create(tenantId, locationInput("Primary"));
    await locationService.create(tenantId, locationInput("Second studio"));
    await expect(
      locationService.create(tenantId, locationInput("Over limit")),
    ).rejects.toMatchObject({ code: "LOCATION_LIMIT_REACHED" });
    expect((await Tenant.findById(tenantId).lean())?.limits.locations).toBe(2);
  });

  it.each(["starter", "professional", "studio_plus"] as const)(
    "rejects new custom roles on %s V3 before creating a role",
    async (plan) => {
      const context = await seedOwner(await seedTenant(plan));
      await expect(createRole(context)).rejects.toMatchObject({
        statusCode: 403,
        code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
        details: { capability: "customRolesAndPermissions" },
      });
      expect(
        await CustomRole.countDocuments({ tenant: context.tenantId }),
      ).toBe(0);
    },
  );

  it.each([
    ["enterprise", 3],
    ["professional", 2],
    ["starter", 1],
  ] as const)(
    "preserves custom-role creation on %s V%s",
    async (plan, version) => {
      const context = await seedOwner(await seedTenant(plan, version));
      const role = await createRole(context);
      expect(role).toMatchObject({
        roleName: "Calendar operator",
        isActive: true,
      });
    },
  );

  it("keeps existing custom roles readable, effective and editable after a downgrade", async () => {
    const context = await seedOwner(await seedTenant("enterprise"));
    const role = await createRole(context);
    const staffId = new mongoose.Types.ObjectId();
    await Membership.create({
      tenant: context.tenantId,
      user: staffId,
      role: "custom",
      customRole: role.roleId,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });
    await Tenant.updateOne(
      { _id: context.tenantId },
      { $set: { plan: "professional" } },
    );
    const edited = await updateWorkspaceCustomRole({
      ...context,
      roleId: role.roleId,
      input: { description: "Existing role remains manageable" },
    });
    expect(edited.description).toBe("Existing role remains manageable");
    expect((await listWorkspaceRoles(context.tenantId)).roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleId: role.roleId, isActive: true }),
        expect.objectContaining({ roleKey: "owner", isBuiltIn: true }),
      ]),
    );
    expect(
      await resolveWorkspaceAccessForUser({
        tenantId: context.tenantId,
        userId: String(staffId),
      }),
    ).toMatchObject({ permissions: [WORKSPACE_PERMISSION.BOOKINGS_VIEW] });
    await expect(createRole(context)).rejects.toMatchObject({
      code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
    });
  });
});
