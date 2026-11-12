import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "507f1f77bcf86cd799439101";
const USER_ID = "507f1f77bcf86cd799439102";
const LOCATION_ID = "507f1f77bcf86cd799439103";
const SECOND_LOCATION_ID = "507f1f77bcf86cd799439104";

const mocks = vi.hoisted(() => ({
  visibilityFilter: vi.fn(),
  conversationFind: vi.fn(),
  conversationCount: vi.fn(),
  taskAggregate: vi.fn(),
  taskCount: vi.fn(),
  taskPopulate: vi.fn(),
  conversationRows: [] as any[],
  taskRows: [] as any[],
  conversationChain: null as any,
}));

const queryChain = (value: unknown) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "limit", "select"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.lean = vi.fn(() => Promise.resolve(value));
  return chain;
};

vi.mock("@/modules/communications/communication.access.js", () => ({
  buildConversationVisibilityFilter: mocks.visibilityFilter,
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationConversationModel: {
    find: mocks.conversationFind,
    countDocuments: mocks.conversationCount,
  },
}));

vi.mock("@/modules/staff/staff-task.model.js", () => ({
  default: {
    aggregate: mocks.taskAggregate,
    countDocuments: mocks.taskCount,
    populate: mocks.taskPopulate,
  },
}));

import { loadDashboardSignals } from "@/modules/dashboard/dashboard.signals.js";
import {
  STAFF_TASK_PRIORITY,
  STAFF_TASK_STATUS,
} from "@/modules/staff/staff.constants.js";
import {
  WORKSPACE_PERMISSION,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

const access = (
  permissions: ResolvedWorkspaceAccess["permissions"] = [
    WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  ],
): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439105",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  role: "staff",
  customRoleId: null,
  customRoleName: null,
  permissions,
  locationAccess: {
    mode: "selected",
    locationIds: [LOCATION_ID, SECOND_LOCATION_ID],
  },
  workspaceProfile: {
    jobTitle: "",
    displayName: "",
    calendarColor: "",
  },
  preferences: {
    language: "en",
    displayTimezone: null,
    defaultLocation: LOCATION_ID,
    defaultCalendarView: "week",
    weekStartsOn: 1,
    defaultLandingPage: "",
    contextualGuides: {},
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: true,
      inApp: true,
    },
  },
  accessVersion: 1,
  isPlatformBypass: false,
});

const enabledModules = {
  [TENANT_MODULE.COMMUNICATIONS]: true,
  [TENANT_MODULE.STAFF_TASKS]: true,
};

describe("dashboard signals loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.visibilityFilter.mockReturnValue({
      tenantId: TENANT_ID,
      visibilityBoundary: true,
    });
    mocks.conversationRows = [
      {
        _id: "507f1f77bcf86cd799439111",
        subject: "  New   course question  ",
        contact: {
          name: "  Anna   Novak  ",
          email: "private@example.test",
          phone: "+420123456789",
        },
        lastMessagePreview: "  Can I join\nnext week?  ",
        lastMessageAt: new Date("2026-07-30T08:00:00.000Z"),
        unreadCount: 2,
        metadata: { secret: true },
      },
      {
        _id: "507f1f77bcf86cd799439112",
        subject: "Glaze pickup",
        contact: { name: "Ben" },
        lastMessagePreview: "Thank you",
        lastMessageAt: new Date("2026-07-30T07:00:00.000Z"),
        unreadCount: 0,
      },
      {
        _id: "507f1f77bcf86cd799439113",
        subject: "Membership",
        contact: { name: "Cara" },
        lastMessagePreview: "Which plan?",
        lastMessageAt: null,
        unreadCount: -4,
      },
      {
        _id: "507f1f77bcf86cd799439114",
        subject: "Must not be returned",
        contact: { name: "Fourth" },
        lastMessagePreview: "Fourth",
        lastMessageAt: null,
        unreadCount: 1,
      },
    ];
    mocks.taskRows = [
      {
        _id: "507f1f77bcf86cd799439121",
        title: "  Prepare   kiln  ",
        assignedTo: {
          firstname: "Eva",
          lastname: "Kral",
          email: "eva@example.test",
        },
        priority: STAFF_TASK_PRIORITY.URGENT,
        dueDate: new Date("2026-07-30T09:00:00.000Z"),
        description: "Must not leave the loader",
      },
      {
        _id: "507f1f77bcf86cd799439122",
        title: "Clean wheels",
        assignedTo: null,
        priority: STAFF_TASK_PRIORITY.HIGH,
        dueDate: new Date("2026-07-30T10:00:00.000Z"),
      },
      {
        _id: "507f1f77bcf86cd799439123",
        title: "Check clay",
        assignedTo: { email: "owner@example.test" },
        priority: STAFF_TASK_PRIORITY.NORMAL,
        dueDate: null,
      },
      {
        _id: "507f1f77bcf86cd799439124",
        title: "Must not be returned",
        assignedTo: null,
        priority: STAFF_TASK_PRIORITY.LOW,
        dueDate: null,
      },
    ];
    mocks.conversationFind.mockImplementation(() => {
      mocks.conversationChain = queryChain(mocks.conversationRows);
      return mocks.conversationChain;
    });
    mocks.conversationCount.mockResolvedValue(4);
    mocks.taskAggregate.mockImplementation(() =>
      Promise.resolve(mocks.taskRows),
    );
    mocks.taskCount.mockResolvedValue(9);
    mocks.taskPopulate.mockImplementation((rows) => Promise.resolve(rows));
  });

  it("returns only safe, bounded summaries within permission, module, and location scope", async () => {
    const result = await loadDashboardSignals({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      modules: enabledModules,
      locationIds: [LOCATION_ID, SECOND_LOCATION_ID],
    });

    expect(mocks.visibilityFilter).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      role: "staff",
      allowedLocationIds: [LOCATION_ID, SECOND_LOCATION_ID],
      view: "all",
      includeRestricted: true,
    });
    const visibility = {
      tenantId: TENANT_ID,
      visibilityBoundary: true,
    };
    expect(mocks.conversationFind).toHaveBeenCalledWith(visibility);
    expect(mocks.conversationCount).toHaveBeenCalledWith({
      $and: [visibility, { unreadCount: { $gt: 0 } }],
    });
    expect(mocks.conversationChain.sort).toHaveBeenCalledWith({
      lastMessageAt: -1,
      _id: -1,
    });
    expect(mocks.conversationChain.limit).toHaveBeenCalledWith(3);
    expect(mocks.conversationChain.select).toHaveBeenCalledWith(
      "_id subject contact.name lastMessagePreview lastMessageAt unreadCount",
    );
    expect(result.messages).toEqual({
      available: true,
      reason: null,
      unreadCount: 4,
      items: [
        {
          id: "507f1f77bcf86cd799439111",
          subject: "New course question",
          contactName: "Anna Novak",
          preview: "Can I join next week?",
          lastMessageAt: "2026-07-30T08:00:00.000Z",
          unreadCount: 2,
        },
        {
          id: "507f1f77bcf86cd799439112",
          subject: "Glaze pickup",
          contactName: "Ben",
          preview: "Thank you",
          lastMessageAt: "2026-07-30T07:00:00.000Z",
          unreadCount: 0,
        },
        {
          id: "507f1f77bcf86cd799439113",
          subject: "Membership",
          contactName: "Cara",
          preview: "Which plan?",
          lastMessageAt: null,
          unreadCount: 0,
        },
      ],
    });
    expect(result.messages.items?.[0]).not.toHaveProperty("contact.email");
    expect(result.messages.items?.[0]).not.toHaveProperty("metadata");

    const taskPipeline = mocks.taskAggregate.mock.calls[0][0];
    const taskFilter = taskPipeline[0].$match;
    expect(String(taskFilter.tenantId)).toBe(TENANT_ID);
    expect(taskFilter.status).toEqual({
      $in: [
        STAFF_TASK_STATUS.TODO,
        STAFF_TASK_STATUS.IN_PROGRESS,
        STAFF_TASK_STATUS.WAITING,
        STAFF_TASK_STATUS.BLOCKED,
      ],
    });
    expect(taskFilter.$or[0]).toEqual({ appliesToAllLocations: true });
    expect(taskFilter.$or[1]).toEqual({
      appliesToAllLocations: false,
      locationId: null,
    });
    expect(
      taskFilter.$or[2].locationId.$in.map((id: unknown) => String(id)),
    ).toEqual([LOCATION_ID, SECOND_LOCATION_ID]);
    expect(taskPipeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $sort: {
            __dashboardDueDateMissing: 1,
            dueDate: 1,
            __dashboardPriorityRank: 1,
            createdAt: 1,
            _id: 1,
          },
        }),
        { $limit: 3 },
      ]),
    );
    expect(mocks.taskCount).toHaveBeenCalledWith(taskFilter);
    expect(mocks.taskPopulate).toHaveBeenCalledWith(mocks.taskRows, {
      path: "assignedTo",
      select: "firstname lastname email",
    });
    expect(result.tasks).toEqual({
      available: true,
      reason: null,
      openCount: 9,
      items: [
        {
          id: "507f1f77bcf86cd799439121",
          title: "Prepare kiln",
          assigneeName: "Eva Kral",
          priority: "urgent",
          dueDate: "2026-07-30T09:00:00.000Z",
        },
        {
          id: "507f1f77bcf86cd799439122",
          title: "Clean wheels",
          assigneeName: null,
          priority: "high",
          dueDate: "2026-07-30T10:00:00.000Z",
        },
        {
          id: "507f1f77bcf86cd799439123",
          title: "Check clay",
          assigneeName: "owner@example.test",
          priority: "normal",
          dueDate: null,
        },
      ],
    });
    expect(result.tasks.items?.[0]).not.toHaveProperty("description");
  });

  it("does not query sources when a required module or permission is unavailable", async () => {
    const disabled = await loadDashboardSignals({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      modules: {},
      locationIds: [LOCATION_ID],
    });

    expect(disabled).toEqual({
      messages: {
        available: false,
        reason: "module_disabled",
        unreadCount: null,
        items: null,
      },
      tasks: {
        available: false,
        reason: "module_disabled",
        openCount: null,
        items: null,
      },
    });

    const restricted = await loadDashboardSignals({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access([]),
      },
      modules: enabledModules,
      locationIds: [LOCATION_ID],
    });

    expect(restricted).toEqual({
      messages: {
        available: false,
        reason: "permission_required",
        unreadCount: null,
        items: null,
      },
      tasks: {
        available: false,
        reason: "permission_required",
        openCount: null,
        items: null,
      },
    });
    expect(mocks.visibilityFilter).not.toHaveBeenCalled();
    expect(mocks.conversationFind).not.toHaveBeenCalled();
    expect(mocks.conversationCount).not.toHaveBeenCalled();
    expect(mocks.taskAggregate).not.toHaveBeenCalled();
    expect(mocks.taskCount).not.toHaveBeenCalled();
    expect(mocks.taskPopulate).not.toHaveBeenCalled();
  });

  it("keeps one source available when the other source fails", async () => {
    mocks.conversationFind.mockImplementationOnce(() => {
      const chain = queryChain(null);
      chain.lean.mockRejectedValue(new Error("messages unavailable"));
      return chain;
    });

    const result = await loadDashboardSignals({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      modules: enabledModules,
      locationIds: [LOCATION_ID],
    });

    expect(result.messages).toEqual({
      available: false,
      reason: "source_temporarily_unavailable",
      unreadCount: null,
      items: null,
    });
    expect(result.tasks.available).toBe(true);
    expect(result.tasks.openCount).toBe(9);
  });

  it("turns an empty resolved task location scope into a deny-all query", async () => {
    mocks.taskRows = [];
    mocks.taskCount.mockResolvedValue(0);

    const result = await loadDashboardSignals({
      context: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        access: access(),
      },
      modules: enabledModules,
      locationIds: [],
    });

    expect(mocks.visibilityFilter).toHaveBeenCalledWith(
      expect.objectContaining({ allowedLocationIds: [] }),
    );
    const taskFilter = mocks.taskAggregate.mock.calls[0][0][0].$match;
    expect(taskFilter).toMatchObject({ _id: { $in: [] } });
    expect(taskFilter).not.toHaveProperty("$or");
    expect(result.tasks).toEqual({
      available: true,
      reason: null,
      openCount: 0,
      items: [],
    });
  });
});
