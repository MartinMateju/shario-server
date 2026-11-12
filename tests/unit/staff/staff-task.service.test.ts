import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  createRepository: vi.fn(),
  moduleEnabled: vi.fn(),
  assertTenantLocations: vi.fn(),
  membershipFindOne: vi.fn(),
  unlinkPlanning: vi.fn(),
  findTaskById: vi.fn(),
  deleteTaskById: vi.fn(),
  updateTaskById: vi.fn(),
  startSession: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}));

const query = (value: unknown) => {
  const result: any = {
    select: vi.fn(() => result),
    lean: vi.fn(async () => value),
  };
  return result;
};

vi.mock("@/modules/staff/staff.repository.js", () => ({
  createStaffRepository: mocks.createRepository,
}));
vi.mock("@/modules/staff/staff-entitlement.service.js", () => ({
  assertStaffTasksModuleEnabled: mocks.moduleEnabled,
}));
vi.mock("@/modules/staff/staff-planning-links.service.js", () => ({
  unlinkStaffTaskFromPlanning: mocks.unlinkPlanning,
}));
vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { findOne: mocks.membershipFindOne },
}));
vi.mock("mongoose", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, startSession: mocks.startSession };
});
vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    assertTenantLocationsWithinWorkspaceScope:
      mocks.assertTenantLocations,
  };
});

import { staffTaskService } from "@/modules/staff/services/staff-task.service.js";
import { createStaffTaskSchema } from "@/modules/staff/staff.validators.js";

describe("staff task MVP service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moduleEnabled.mockResolvedValue(undefined);
    mocks.assertTenantLocations.mockResolvedValue(["location-a"]);
    mocks.membershipFindOne.mockReturnValue(
      query({
        status: "active",
        locationAccess: {
          mode: "selected",
          locationIds: ["location-a"],
        },
      }),
    );
    mocks.createTask.mockResolvedValue({ _id: "task-a" });
    mocks.listTasks.mockResolvedValue({ tasks: [], total: 0 });
    mocks.unlinkPlanning.mockResolvedValue({
      daily: 0,
      weekly: 0,
      monthly: 0,
    });
    mocks.findTaskById.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      appliesToAllLocations: false,
      locationId: "location-a",
    });
    mocks.deleteTaskById.mockResolvedValue({ deletedCount: 1 });
    mocks.updateTaskById.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      locationId: "location-b",
      appliesToAllLocations: false,
    });
    mocks.withTransaction.mockImplementation(async (work) => work());
    mocks.endSession.mockResolvedValue(undefined);
    mocks.startSession.mockResolvedValue({
      withTransaction: mocks.withTransaction,
      endSession: mocks.endSession,
    });
    mocks.createRepository.mockReturnValue({
      createTask: mocks.createTask,
      listTasks: mocks.listTasks,
      findTaskById: mocks.findTaskById,
      deleteTaskById: mocks.deleteTaskById,
      updateTaskById: mocks.updateTaskById,
    });
  });

  it("makes a title-only task immediately visible in a selected location", async () => {
    const input = createStaffTaskSchema.parse({ title: "Clean shelves" });
    await staffTaskService.create(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: ["location-a"],
      },
      input,
    );

    expect(mocks.createTask).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({
        title: "Clean shelves",
        locationId: "location-a",
        appliesToAllLocations: false,
        dueDate: null,
      }),
      {},
    );
  });

  it("validates a requested list location against the tenant before querying", async () => {
    await staffTaskService.list(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: null,
      },
      {
        location: "507f1f77bcf86cd799439011",
        page: 1,
        limit: 50,
      },
    );

    expect(mocks.assertTenantLocations).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      locationIds: ["507f1f77bcf86cd799439011"],
      allowedLocationIds: null,
    });
  });

  it("returns no tasks for an empty selected location scope", async () => {
    const result = await staffTaskService.list(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: [],
      },
      { page: 1, limit: 50 },
    );

    expect(result).toEqual({
      tasks: [],
      total: 0,
      page: 1,
      limit: 50,
      pages: 0,
    });
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("rejects task creation for an empty selected location scope", async () => {
    const input = createStaffTaskSchema.parse({ title: "Clean shelves" });

    await expect(
      staffTaskService.create(
        {
          tenantId: "tenant-a",
          id: "user-a",
          allowedLocationIds: [],
        },
        input,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("requires an all-location assignee for an effective global task", async () => {
    const input = createStaffTaskSchema.parse({
      title: "Studio-wide follow-up",
      assignedTo: "507f1f77bcf86cd799439012",
    });

    await expect(
      staffTaskService.create(
        {
          tenantId: "tenant-a",
          id: "user-a",
          allowedLocationIds: null,
        },
        input,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("unlinks planning references before deleting a task", async () => {
    await staffTaskService.delete(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: ["location-a"],
      },
      "507f1f77bcf86cd799439011",
    );

    expect(mocks.unlinkPlanning).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      taskId: "507f1f77bcf86cd799439011",
      session: {
        withTransaction: mocks.withTransaction,
        endSession: mocks.endSession,
      },
    });
    expect(mocks.unlinkPlanning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteTaskById.mock.invocationCallOrder[0],
    );
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("preserves the task when planning-link cleanup fails", async () => {
    mocks.unlinkPlanning.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      staffTaskService.delete(
        {
          tenantId: "tenant-a",
          id: "user-a",
          allowedLocationIds: ["location-a"],
        },
        "507f1f77bcf86cd799439011",
      ),
    ).rejects.toThrow("cleanup failed");
    expect(mocks.deleteTaskById).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("atomically unlinks planning references when a task changes scope", async () => {
    await staffTaskService.update(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: ["location-a", "location-b"],
      },
      "507f1f77bcf86cd799439011",
      { locationId: "location-b" },
    );

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.unlinkPlanning).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      taskId: "507f1f77bcf86cd799439011",
      session: {
        withTransaction: mocks.withTransaction,
        endSession: mocks.endSession,
      },
    });
    expect(mocks.unlinkPlanning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateTaskById.mock.invocationCallOrder[0],
    );
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

  it("re-reads and authorizes a non-scope patch inside a transaction", async () => {
    await staffTaskService.update(
      {
        tenantId: "tenant-a",
        id: "user-a",
        allowedLocationIds: ["location-a"],
      },
      "507f1f77bcf86cd799439011",
      { status: "in-progress" },
    );

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.findTaskById).toHaveBeenCalledTimes(1);
    expect(mocks.updateTaskById).toHaveBeenCalledWith(
      "507f1f77bcf86cd799439011",
      { status: "in-progress" },
    );
    expect(mocks.unlinkPlanning).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledTimes(1);
  });

});
