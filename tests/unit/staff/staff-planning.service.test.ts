import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dailyFindOne = vi.fn();
  const dailyFindOneAndUpdate = vi.fn();
  const membershipFindOne = vi.fn();
  const profileFindOneAndUpdate = vi.fn();
  const settingsFindOneAndUpdate = vi.fn();
  const weeklyFindOne = vi.fn();
  const weeklyFindOneAndUpdate = vi.fn();
  const monthlyFindOne = vi.fn();
  const monthlyFindOneAndUpdate = vi.fn();
  const planningTaskFind = vi.fn();
  const tenantFindById = vi.fn();
  return {
    dailyFindOne,
    dailyFindOneAndUpdate,
    membershipFindOne,
    profileFindOneAndUpdate,
    settingsFindOneAndUpdate,
    weeklyFindOne,
    weeklyFindOneAndUpdate,
    monthlyFindOne,
    monthlyFindOneAndUpdate,
    planningTaskFind,
    tenantFindById,
    moduleEnabled: vi.fn(),
    hasPermission: vi.fn(),
    allowedLocations: vi.fn(),
    assertLocations: vi.fn(),
  };
});

const chain = (value: unknown) => {
  const query: any = {
    select: vi.fn(() => query),
    sort: vi.fn(() => query),
    lean: vi.fn(async () => value),
  };
  return query;
};

vi.mock("@/modules/staff/staff-entitlement.service.js", () => ({
  assertStaffTasksModuleEnabled: mocks.moduleEnabled,
}));
vi.mock("@/modules/staff/staff-task.model.js", () => ({
  default: { find: mocks.planningTaskFind },
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: {
    findById: mocks.tenantFindById,
  },
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: {
    findOne: mocks.membershipFindOne,
  },
}));
vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    hasWorkspacePermission: mocks.hasPermission,
    getAllowedWorkspaceLocationIds: mocks.allowedLocations,
    assertTenantLocationsWithinWorkspaceScope: mocks.assertLocations,
  };
});
vi.mock("@/modules/staff/staff-planning.models.js", () => ({
  StaffDailyUpdateModel: {
    findOne: mocks.dailyFindOne,
    findOneAndUpdate: mocks.dailyFindOneAndUpdate,
  },
  StaffWeeklyPlanModel: {
    findOne: mocks.weeklyFindOne,
    findOneAndUpdate: mocks.weeklyFindOneAndUpdate,
  },
  StaffMonthlyPrioritySetModel: {
    findOne: mocks.monthlyFindOne,
    findOneAndUpdate: mocks.monthlyFindOneAndUpdate,
  },
  StaffPlanningProfileModel: {
    findOneAndUpdate: mocks.profileFindOneAndUpdate,
  },
  StaffPlanningSettingsModel: {
    findOneAndUpdate: mocks.settingsFindOneAndUpdate,
  },
}));

import {
  updateDailyAttention,
  updateMemberSchedule,
  updatePlanningSettings,
  upsertDailyUpdate,
  upsertMonthlyPriorities,
  upsertWeeklyPlan,
} from "@/modules/staff/staff-planning.service.js";

const context: any = {
  tenantId: "tenant-a",
  userId: "user-a",
  access: {
    permissions: ["planning.submit", "tasks.view"],
    locationAccess: { mode: "selected", locationIds: ["location-a"] },
    preferences: { defaultLocation: "location-a" },
  },
  now: new Date("2026-07-28T08:30:00.000Z"),
};

describe("staff planning self-write service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moduleEnabled.mockResolvedValue(undefined);
    mocks.allowedLocations.mockReturnValue(["location-a"]);
    mocks.hasPermission.mockImplementation(
      (_access, permission) =>
        permission === "planning.submit" || permission === "tasks.view",
    );
    mocks.assertLocations.mockResolvedValue(["location-a"]);
    mocks.tenantFindById.mockReturnValue(
      chain({ settings: { timezone: "Europe/Prague" } }),
    );
    mocks.membershipFindOne.mockReturnValue(
      chain({
        _id: "member-a",
        tenant: "tenant-a",
        user: "user-a",
        status: "active",
      }),
    );
    mocks.dailyFindOne.mockReturnValue(chain(null));
    mocks.weeklyFindOne.mockReturnValue(chain(null));
    mocks.monthlyFindOne.mockReturnValue(chain(null));
    mocks.planningTaskFind.mockImplementation((filter) => {
      const ids = (filter?._id?.$in || []).map(String);
      return chain(
        ids.includes("507f1f77bcf86cd799439011")
          ? [{ _id: "507f1f77bcf86cd799439011" }]
          : [],
      );
    });
    mocks.dailyFindOneAndUpdate.mockImplementation(
      async (filter, update) => ({
        _id: "update-a",
        ...filter,
        ...update.$set,
        updatedAt: context.now,
      }),
    );
    mocks.weeklyFindOneAndUpdate.mockImplementation(
      async (filter, update) => ({
        _id: "plan-a",
        ...filter,
        ...update.$set,
        updatedAt: context.now,
      }),
    );
    mocks.monthlyFindOneAndUpdate.mockImplementation(
      async (filter, update) => ({
        _id: "priority-set-a",
        ...filter,
        ...update.$set,
        updatedAt: context.now,
      }),
    );
  });

  it("pins every retry to the same tenant/user/local-date key", async () => {
    const input = {
      focusToday: "Prepare clay",
      completedSinceLast: "",
      blockers: "",
      notWorkingToday: false,
      needsOwnerAttention: false,
      locationId: "location-a",
      linkedTaskIds: [],
    };
    await upsertDailyUpdate(context, "2026-07-28", input);
    await upsertDailyUpdate(context, "2026-07-28", input);

    expect(mocks.dailyFindOneAndUpdate).toHaveBeenCalledTimes(2);
    for (const [filter] of mocks.dailyFindOneAndUpdate.mock.calls) {
      expect(filter).toEqual({
        tenantId: "tenant-a",
        userId: "user-a",
        dateKey: "2026-07-28",
      });
    }
  });

  it("clears work claims, blockers, attention and task links for not-working", async () => {
    await upsertDailyUpdate(context, "2026-07-28", {
      focusToday: "Must be cleared",
      completedSinceLast: "Must be cleared",
      blockers: "Must be cleared",
      notWorkingToday: true,
      needsOwnerAttention: true,
      locationId: "location-a",
      linkedTaskIds: ["507f1f77bcf86cd799439011"],
    });

    const update = mocks.dailyFindOneAndUpdate.mock.calls[0][1].$set;
    expect(update).toMatchObject({
      focusToday: "",
      completedSinceLast: "",
      blockers: "",
      notWorkingToday: true,
      needsOwnerAttention: false,
      attentionStatus: "none",
      linkedTaskIds: [],
    });
  });

  it("preserves hidden daily task links when the field is omitted", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        attentionStatus: "none",
        locationId: "location-a",
        linkedTaskIds: ["507f1f77bcf86cd799439011"],
      }),
    );

    await upsertDailyUpdate(context, "2026-07-28", {
      focusToday: "Prepare clay",
      completedSinceLast: "",
      blockers: "",
      notWorkingToday: false,
      needsOwnerAttention: false,
      locationId: "location-a",
    });

    expect(
      mocks.dailyFindOneAndUpdate.mock.calls[0][1].$set.linkedTaskIds,
    ).toEqual(["507f1f77bcf86cd799439011"]);
  });

  it("ignores an explicit daily link clear without task visibility", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        attentionStatus: "none",
        locationId: "location-a",
        linkedTaskIds: ["507f1f77bcf86cd799439011"],
      }),
    );

    await upsertDailyUpdate(context, "2026-07-28", {
      focusToday: "Prepare clay",
      completedSinceLast: "",
      blockers: "",
      notWorkingToday: false,
      needsOwnerAttention: false,
      locationId: "location-a",
      linkedTaskIds: [],
    });

    expect(
      mocks.dailyFindOneAndUpdate.mock.calls[0][1].$set.linkedTaskIds,
    ).toEqual(["507f1f77bcf86cd799439011"]);
  });

  it("rejects moving a daily update with hidden links", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        attentionStatus: "none",
        locationId: "location-a",
        linkedTaskIds: ["507f1f77bcf86cd799439011"],
      }),
    );

    await expect(
      upsertDailyUpdate(context, "2026-07-28", {
        focusToday: "Prepare clay",
        completedSinceLast: "",
        blockers: "",
        notWorkingToday: false,
        needsOwnerAttention: false,
        locationId: "location-b",
        linkedTaskIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.dailyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects moving a not-working daily update with hidden links", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        attentionStatus: "none",
        locationId: "location-a",
        linkedTaskIds: ["507f1f77bcf86cd799439011"],
      }),
    );

    await expect(
      upsertDailyUpdate(context, "2026-07-28", {
        focusToday: "",
        completedSinceLast: "",
        blockers: "",
        notWorkingToday: true,
        needsOwnerAttention: false,
        locationId: "location-b",
        linkedTaskIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.dailyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("filters a concurrently moved task from the daily response", async () => {
    mocks.dailyFindOneAndUpdate.mockResolvedValueOnce({
      _id: "update-a",
      userId: "user-a",
      dateKey: "2026-07-28",
      locationId: "location-a",
      focusToday: "Prepare clay",
      linkedTaskIds: ["507f1f77bcf86cd799439012"],
    });

    const result: any = await upsertDailyUpdate(
      context,
      "2026-07-28",
      {
        focusToday: "Prepare clay",
        completedSinceLast: "",
        blockers: "",
        notWorkingToday: false,
        needsOwnerAttention: false,
        locationId: "location-a",
      },
    );

    expect(result.linkedTaskIds).toEqual([]);
  });

  it("preserves weekly row links by id without task visibility", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.weeklyFindOne.mockReturnValue(
      chain({
        locationId: "location-a",
        outcomes: [
          {
            _id: "507f1f77bcf86cd799439012",
            title: "Old",
            linkedTaskIds: ["507f1f77bcf86cd799439011"],
          },
        ],
      }),
    );

    const result: any = await upsertWeeklyPlan(context, "2026-07-27", {
      locationId: "location-a",
      outcomes: [
        {
          id: "507f1f77bcf86cd799439012",
          title: "Updated",
          completed: false,
          linkedTaskIds: [],
        },
      ],
    });

    expect(
      mocks.weeklyFindOneAndUpdate.mock.calls[0][1].$set.outcomes[0]
        .linkedTaskIds,
    ).toEqual(["507f1f77bcf86cd799439011"]);
    expect(result.outcomes[0]).not.toHaveProperty("linkedTaskIds");
  });

  it("rejects moving a weekly plan with hidden links", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.submit",
    );
    mocks.weeklyFindOne.mockReturnValue(
      chain({
        locationId: "location-a",
        outcomes: [
          {
            _id: "507f1f77bcf86cd799439012",
            linkedTaskIds: ["507f1f77bcf86cd799439011"],
          },
        ],
      }),
    );

    await expect(
      upsertWeeklyPlan(context, "2026-07-27", {
        locationId: "location-b",
        outcomes: [
          {
            id: "507f1f77bcf86cd799439012",
            title: "Updated",
            completed: false,
            linkedTaskIds: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.weeklyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("filters a concurrently moved task from the weekly response", async () => {
    mocks.weeklyFindOneAndUpdate.mockResolvedValueOnce({
      _id: "plan-a",
      userId: "user-a",
      weekStartKey: "2026-07-27",
      locationId: "location-a",
      outcomes: [
        {
          _id: "507f1f77bcf86cd799439013",
          title: "Prepare workshop",
          completed: false,
          linkedTaskIds: ["507f1f77bcf86cd799439012"],
        },
      ],
    });

    const result: any = await upsertWeeklyPlan(
      context,
      "2026-07-27",
      {
        locationId: "location-a",
        outcomes: [{ title: "Prepare workshop", completed: false }],
      },
    );

    expect(result.outcomes[0].linkedTaskIds).toEqual([]);
  });

  it("fails closed when a submitter has an empty selected location scope", async () => {
    mocks.allowedLocations.mockReturnValue([]);

    await expect(
      upsertDailyUpdate(context, "2026-07-28", {
        focusToday: "Prepare clay",
        completedSinceLast: "",
        blockers: "",
        notWorkingToday: false,
        needsOwnerAttention: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "STAFF_PLANNING_LOCATION_SCOPE_REQUIRED",
    });
    expect(mocks.dailyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("preserves and redacts monthly links without task visibility", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.monthlyFindOne.mockReturnValue(
      chain({
        priorities: [
          {
            _id: "507f1f77bcf86cd799439012",
            linkedTaskIds: ["507f1f77bcf86cd799439011"],
          },
        ],
      }),
    );

    const result: any = await upsertMonthlyPriorities(context, "2026-07", {
      locationId: "location-a",
      priorities: [
        {
          id: "507f1f77bcf86cd799439012",
          title: "Improve kiln flow",
          ownerUserId: null,
          completed: false,
          linkedTaskIds: [],
        },
      ],
    });

    expect(
      mocks.monthlyFindOneAndUpdate.mock.calls[0][1].$set.priorities[0]
        .linkedTaskIds,
    ).toEqual(["507f1f77bcf86cd799439011"]);
    expect(result.priorities[0]).not.toHaveProperty("linkedTaskIds");
  });

  it("preserves hidden B task ids while an A manager clears visible monthly links", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) =>
        permission === "planning.manage" || permission === "tasks.view",
    );
    mocks.monthlyFindOne.mockReturnValue(
      chain({
        priorities: [
          {
            _id: "507f1f77bcf86cd799439013",
            linkedTaskIds: [
              "507f1f77bcf86cd799439011",
              "507f1f77bcf86cd799439012",
            ],
          },
        ],
      }),
    );

    const result: any = await upsertMonthlyPriorities(context, "2026-07", {
      locationId: "location-a",
      priorities: [
        {
          id: "507f1f77bcf86cd799439013",
          title: "Improve kiln flow",
          ownerUserId: null,
          completed: false,
          linkedTaskIds: [],
        },
      ],
    });

    expect(
      mocks.monthlyFindOneAndUpdate.mock.calls[0][1].$set.priorities[0]
        .linkedTaskIds,
    ).toEqual(["507f1f77bcf86cd799439012"]);
    expect(result.priorities[0].linkedTaskIds).toEqual([]);
  });

  it("requires an all-location owner for a global monthly priority", async () => {
    mocks.allowedLocations.mockReturnValue(null);
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.membershipFindOne
      .mockReturnValueOnce(
        chain({
          _id: "member-a",
          tenant: "tenant-a",
          user: "user-a",
          status: "active",
        }),
      )
      .mockReturnValueOnce(
        chain({
          _id: "member-b",
          tenant: "tenant-a",
          user: "507f1f77bcf86cd799439012",
          status: "active",
          locationAccess: {
            mode: "selected",
            locationIds: ["location-b"],
          },
        }),
      );

    await expect(
      upsertMonthlyPriorities(context, "2026-07", {
        locationId: null,
        priorities: [
          {
            title: "Studio-wide quality",
            ownerUserId: "507f1f77bcf86cd799439012",
            completed: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.monthlyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("prevents a location-limited manager from changing a cross-location schedule", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.membershipFindOne.mockReturnValue(
      chain({
        _id: "member-b",
        tenant: "tenant-a",
        user: "user-b",
        status: "active",
        locationAccess: {
          mode: "selected",
          locationIds: ["location-a", "location-b"],
        },
      }),
    );

    await expect(
      updateMemberSchedule(
        {
          ...context,
          access: {
            ...context.access,
            permissions: ["planning.manage"],
          },
        },
        "507f1f77bcf86cd799439011",
        { expectedWeekdays: [1, 2, 3, 4, 5] },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.profileFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("prevents a location-limited manager from changing an unscoped schedule", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.membershipFindOne.mockReturnValue(
      chain({
        _id: "member-b",
        tenant: "tenant-a",
        user: "user-b",
        status: "active",
        locationAccess: { mode: "selected", locationIds: [] },
      }),
    );

    await expect(
      updateMemberSchedule(
        {
          ...context,
          access: {
            ...context.access,
            permissions: ["planning.manage"],
          },
        },
        "507f1f77bcf86cd799439011",
        { expectedWeekdays: [1, 2, 3, 4, 5] },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.profileFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("requires all-location access to mutate a legacy null-scope attention item", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        _id: "507f1f77bcf86cd799439011",
        tenantId: "tenant-a",
        userId: "user-b",
        locationId: null,
        needsOwnerAttention: true,
        attentionStatus: "needs-attention",
      }),
    );

    await expect(
      updateDailyAttention(
        {
          ...context,
          access: {
            ...context.access,
            permissions: ["planning.manage"],
          },
        },
        "507f1f77bcf86cd799439011",
        "acknowledged",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.dailyFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("atomically pins an attention update to its authorized location", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );
    mocks.dailyFindOne.mockReturnValue(
      chain({
        _id: "507f1f77bcf86cd799439011",
        tenantId: "tenant-a",
        userId: "user-b",
        locationId: "location-a",
        needsOwnerAttention: true,
        attentionStatus: "needs-attention",
      }),
    );

    await updateDailyAttention(
      {
        ...context,
        access: {
          ...context.access,
          permissions: ["planning.manage"],
        },
      },
      "507f1f77bcf86cd799439011",
      "acknowledged",
    );

    expect(mocks.dailyFindOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: "507f1f77bcf86cd799439011",
      tenantId: "tenant-a",
      locationId: "location-a",
      needsOwnerAttention: true,
    });
  });

  it("requires all-location access to change tenant-global planning settings", async () => {
    mocks.hasPermission.mockImplementation(
      (_access, permission) => permission === "planning.manage",
    );

    await expect(
      updatePlanningSettings(
        {
          ...context,
          access: {
            ...context.access,
            permissions: ["planning.manage"],
          },
        },
        { expectedUpdateTime: "09:00" },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
