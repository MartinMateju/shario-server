import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenantFindById: vi.fn(),
  locationFind: vi.fn(),
  productFind: vi.fn(),
  taskFind: vi.fn(),
  itemFind: vi.fn(),
  hasPermission: vi.fn(),
  canAccessLocation: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.tenantFindById },
}));
vi.mock("@/modules/location/location.model.js", () => ({
  default: { find: mocks.locationFind },
}));
vi.mock("@/modules/product/product.model.js", () => ({
  default: { find: mocks.productFind },
}));
vi.mock("@/modules/staff/staff-task.model.js", () => ({
  default: { find: mocks.taskFind },
}));
vi.mock("@/modules/inventory/inventory.model.js", () => ({
  InventoryItem: { find: mocks.itemFind },
}));
vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  hasWorkspacePermission: mocks.hasPermission,
  canAccessWorkspaceLocation: mocks.canAccessLocation,
}));

import { buildAiCommandContext } from "@/modules/ai/services/ai-command-context.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";

const access = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  locationAccess: { mode: "all", locationIds: [] },
};

const tenantQuery = (value: unknown) => ({
  select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});
const locationQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    sort: vi.fn(() => ({
      limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
    })),
  })),
});
const targetQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    sort: vi.fn(() => ({
      limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
    })),
  })),
});

describe("AI command context authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenantFindById.mockReturnValue(
      tenantQuery({
        modules: { staff_tasks: true, inventory: true, courses: true },
      }),
    );
    mocks.locationFind.mockReturnValue(
      locationQuery([
        {
          _id: LOCATION_ID,
          name: "Main studio",
          booking: {
            enabled: true,
            timezone: "Europe/Prague",
            slotStepMinutes: 30,
            minBookingMinutes: 60,
            maxBookingMinutes: 360,
          },
          openingHours: {},
        },
      ]),
    );
    mocks.productFind.mockReturnValue(targetQuery([]));
    mocks.taskFind.mockReturnValue(targetQuery([]));
    mocks.itemFind.mockReturnValue(targetQuery([]));
    mocks.canAccessLocation.mockReturnValue(true);
  });

  it("allows task creation without enumerating data the actor cannot view", async () => {
    const permissions = new Set<string>([
      WORKSPACE_PERMISSION.TASKS_MANAGE,
      WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    ]);
    mocks.hasPermission.mockImplementation((_access, permission) =>
      permissions.has(permission),
    );

    const result = await buildAiCommandContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access as any,
    });

    expect(result.capabilities.map(({ key }) => key)).toEqual(["create_task"]);
    expect(result.openTasks).toEqual([]);
    expect(result.lowStockItems).toEqual([]);
    expect(mocks.taskFind).not.toHaveBeenCalled();
    expect(mocks.itemFind).not.toHaveBeenCalled();
  });

  it("enumerates exact completion and reorder targets only with view and manage", async () => {
    const permissions = new Set<string>([
      WORKSPACE_PERMISSION.TASKS_MANAGE,
      WORKSPACE_PERMISSION.TASKS_VIEW,
      WORKSPACE_PERMISSION.INVENTORY_MANAGE,
      WORKSPACE_PERMISSION.INVENTORY_VIEW,
      WORKSPACE_PERMISSION.COURSES_MANAGE,
    ]);
    mocks.hasPermission.mockImplementation((_access, permission) =>
      permissions.has(permission),
    );
    mocks.taskFind.mockReturnValue(
      targetQuery([
        {
          _id: "507f1f77bcf86cd799439014",
          title: "Call customer",
          status: "todo",
          locationId: LOCATION_ID,
          appliesToAllLocations: false,
          assignedTo: null,
          updatedAt: new Date("2026-08-03T08:00:00.000Z"),
        },
      ]),
    );
    mocks.itemFind.mockReturnValue(
      targetQuery([
        {
          _id: "507f1f77bcf86cd799439015",
          name: "Clay",
          unit: "kg",
          updatedAt: new Date("2026-08-03T08:00:00.000Z"),
          stockLevels: [
            {
              location: LOCATION_ID,
              currentQuantity: 2,
              minimumQuantity: 5,
            },
          ],
        },
      ]),
    );

    const result = await buildAiCommandContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access as any,
    });

    expect(result.capabilities.map(({ key }) => key)).toEqual([
      "create_task",
      "complete_task",
      "create_inventory_reorder_request",
      "create_event",
    ]);
    expect(result.openTasks).toHaveLength(1);
    expect(result.lowStockItems).toHaveLength(1);
  });

  it.each([
    ["products.view", WORKSPACE_PERMISSION.PRODUCTS_VIEW],
    ["locations.view", WORKSPACE_PERMISSION.LOCATIONS_VIEW],
  ])(
    "does not offer the booking composer when %s is missing",
    async (_label, omittedPermission) => {
      mocks.tenantFindById.mockReturnValue(
        tenantQuery({ modules: { bookings: true } }),
      );
      const permissions = new Set<string>([
        WORKSPACE_PERMISSION.BOOKINGS_CREATE,
        WORKSPACE_PERMISSION.LOCATIONS_VIEW,
        WORKSPACE_PERMISSION.PRODUCTS_VIEW,
      ]);
      permissions.delete(omittedPermission);
      mocks.hasPermission.mockImplementation((_access, permission) =>
        permissions.has(permission),
      );

      const result = await buildAiCommandContext({
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access as any,
      });

      expect(result.assistantCapabilities.bookingComposer).toEqual({
        enabled: false,
        prefillEnabled: false,
        directMutation: false,
      });
      expect(result.locations).toEqual([]);
      expect(result.bookingProducts).toEqual([]);
      expect(mocks.locationFind).not.toHaveBeenCalled();
      expect(mocks.productFind).not.toHaveBeenCalled();
    },
  );

  it("offers only a usable booking composer with all route dependencies", async () => {
    mocks.tenantFindById.mockReturnValue(
      tenantQuery({ modules: { bookings: true } }),
    );
    const permissions = new Set<string>([
      WORKSPACE_PERMISSION.BOOKINGS_CREATE,
      WORKSPACE_PERMISSION.LOCATIONS_VIEW,
      WORKSPACE_PERMISSION.PRODUCTS_VIEW,
      WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    ]);
    mocks.hasPermission.mockImplementation((_access, permission) =>
      permissions.has(permission),
    );
    mocks.productFind.mockReturnValue(
      targetQuery([
        {
          _id: "507f1f77bcf86cd799439099",
          name: "Wheel Session",
          kind: "class",
        },
      ]),
    );

    const result = await buildAiCommandContext({
      tenantId: TENANT_ID,
      userId: USER_ID,
      access: access as any,
    });

    expect(result.assistantCapabilities.bookingComposer).toEqual({
      enabled: true,
      prefillEnabled: true,
      directMutation: false,
    });
    expect(result.locations).toEqual([
      expect.objectContaining({
        id: LOCATION_ID,
        name: "Main studio",
        booking: expect.objectContaining({ enabled: true }),
      }),
    ]);
    expect(result.bookingProducts).toEqual([
      {
        id: "507f1f77bcf86cd799439099",
        name: "Wheel Session",
        kind: "class",
      },
    ]);
  });

});

