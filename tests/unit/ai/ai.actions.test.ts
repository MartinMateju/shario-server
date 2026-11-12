import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actionCreate: vi.fn(),
  actionFind: vi.fn(),
  actionFindOne: vi.fn(),
  actionFindOneAndUpdate: vi.fn(),
  actionUpdateMany: vi.fn(),
  actionCount: vi.fn(),
  eventUpdateOne: vi.fn(),
  eventFind: vi.fn(),
  conversationExists: vi.fn(),
  conversationDistinct: vi.fn(),
  resolveAccess: vi.fn(),
  hasPermission: vi.fn(),
  canAccessLocation: vi.fn(),
  tenantExists: vi.fn(),
  locationExists: vi.fn(),
  locationFindOne: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  taskFindOne: vi.fn(),
  itemFindOne: vi.fn(),
  reorderFindOne: vi.fn(),
  createReorder: vi.fn(),
  eventFindOne: vi.fn(),
  createEvent: vi.fn(),
  resolveSuggestion: vi.fn(),
  getDefinition: vi.fn(),
}));

vi.mock("@/modules/ai/ai.models.js", () => ({
  AiActionModel: {
    create: mocks.actionCreate,
    find: mocks.actionFind,
    findOne: mocks.actionFindOne,
    findOneAndUpdate: mocks.actionFindOneAndUpdate,
    updateMany: mocks.actionUpdateMany,
    countDocuments: mocks.actionCount,
  },
  AiActionEventModel: {
    updateOne: mocks.eventUpdateOne,
    find: mocks.eventFind,
  },
  AiConversationModel: {
    exists: mocks.conversationExists,
    distinct: mocks.conversationDistinct,
  },
}));

vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  resolveWorkspaceAccessForUser: mocks.resolveAccess,
  hasWorkspacePermission: mocks.hasPermission,
  canAccessWorkspaceLocation: mocks.canAccessLocation,
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { exists: mocks.tenantExists },
}));

vi.mock("@/modules/location/location.model.js", () => ({
  default: {
    exists: mocks.locationExists,
    findOne: mocks.locationFindOne,
  },
}));

vi.mock("@/modules/staff/staff-task.model.js", () => ({
  default: { findOne: mocks.taskFindOne },
}));

vi.mock("@/modules/staff/services/staff-task.service.js", () => ({
  staffTaskService: {
    create: mocks.createTask,
    update: mocks.updateTask,
  },
}));

vi.mock("@/modules/staff/staff.validators.js", () => ({
  createStaffTaskSchema: { parse: (value: unknown) => value },
}));

vi.mock("@/modules/inventory/inventory.model.js", () => ({
  InventoryItem: { findOne: mocks.itemFindOne },
}));

vi.mock("@/modules/inventory/reorder-request.schema.js", () => ({
  ReorderRequest: { findOne: mocks.reorderFindOne },
}));

vi.mock("@/modules/inventory/services/inventory.service.js", () => ({
  inventoryService: { createReorderRequest: mocks.createReorder },
}));

vi.mock("@/modules/inventory/inventory.validators.js", () => ({
  createReorderRequestSchema: { parse: (value: unknown) => value },
}));

vi.mock("@/modules/event/event.repository.js", () => ({
  eventRepository: {
    findByAiActionIdForTenant: mocks.eventFindOne,
  },
}));

vi.mock("@/modules/event/services/event.service.js", () => ({
  eventService: { create: mocks.createEvent },
}));

vi.mock("@/modules/ai/services/ai-action.registry.js", () => ({
  getAiActionDefinition: mocks.getDefinition,
  resolveAiActionSuggestion: mocks.resolveSuggestion,
}));

import {
  confirmAiAction,
  dismissAiAction,
  getAiAction,
  getVisibleConversationAiActions,
  isExplicitAiCommandRequest,
  isExplicitCreateEventCommandRequest,
  resolveExplicitEventCommandLocation,
  listAiActions,
  persistSuggestedActions,
  serializeAiAction,
} from "@/modules/ai/services/ai-action.service.js";
import {
  AI_ACTION_RISK,
  AI_ACTION_SCHEMA_VERSION,
  AI_ACTION_STATUS,
  AI_AUDIENCE,
} from "@/modules/ai/ai.constants.js";
import type { AiRequestContext } from "@/modules/ai/ai.types.js";
import type { AiCommandContext } from "@/modules/ai/ai-action.types.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const CONVERSATION_ID = "507f1f77bcf86cd799439013";
const MESSAGE_ID = "507f1f77bcf86cd799439014";
const ACTION_ID = "507f1f77bcf86cd799439015";
const LOCATION_ID = "507f1f77bcf86cd799439016";

const access = (
  overrides: Partial<ResolvedWorkspaceAccess> = {},
): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439020",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  role: "owner",
  customRoleId: null,
  customRoleName: null,
  permissions: [WORKSPACE_PERMISSION.TASKS_MANAGE],
  locationAccess: { mode: "all", locationIds: [] },
  workspaceProfile: { jobTitle: "", displayName: "", calendarColor: "" },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: null,
    defaultCalendarView: "month",
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
  ...overrides,
});

const context = (
  overrides: Partial<AiRequestContext> = {},
): AiRequestContext => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  audience: AI_AUDIENCE.WORKSPACE,
  access: access(),
  allowedLocationIds: null,
  ...overrides,
});

const commandContext: AiCommandContext = {
  generatedAt: new Date().toISOString(),
  capabilities: [
    {
      key: "create_task",
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      riskLevel: AI_ACTION_RISK.LOW,
    },
  ],
  assistantCapabilities: {
    readableDomains: ["tasks"],
    preparableActions: ["create_task"],
    bookingComposer: {
      enabled: false,
      prefillEnabled: false,
      directMutation: false,
    },
  },
  locations: [
    {
      id: LOCATION_ID,
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
  ],
  bookingProducts: [],
  openTasks: [],
  lowStockItems: [],
};

const payload = {
  title: "Call the customer",
  description: "Confirm collection time.",
  locationId: LOCATION_ID,
  appliesToAllLocations: false,
  dueDate: null,
  priority: "high" as const,
};

const digest = createHash("sha256")
  .update(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(payload).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  )
  .digest("hex");

const action = (overrides: Record<string, unknown> = {}) => ({
  _id: ACTION_ID,
  tenant: TENANT_ID,
  conversation: CONVERSATION_ID,
  requestedBy: USER_ID,
  key: "create_task",
  label: "Create task: Call the customer",
  schemaVersion: AI_ACTION_SCHEMA_VERSION,
  payload,
  payloadHash: digest,
  preview: {
    title: payload.title,
    summary: "Create an internal studio task",
    fields: [{ key: "scope", value: "Main studio" }],
    warnings: [],
    target: { type: "workspace", id: LOCATION_ID, label: "Main studio" },
  },
  targetSnapshot: {
    type: "workspace",
    id: LOCATION_ID,
    locationId: LOCATION_ID,
  },
  requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
  requiredModule: "staff_tasks",
  riskLevel: "low",
  locationId: LOCATION_ID,
  status: AI_ACTION_STATUS.SUGGESTED,
  result: null,
  errorCode: "",
  executionAttempts: 0,
  executionVersion: 0,
  leaseExpiresAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  decidedAt: null,
  completedAt: null,
  save: vi.fn(),
  ...overrides,
});

const EVENT_ID = "507f1f77bcf86cd799439093";
const eventPayload = {
  title: "Private workshop",
  locationId: LOCATION_ID,
  date: "2099-09-15",
  startTime: "09:00",
  endTime: "10:00",
};
const eventDigest = createHash("sha256")
  .update(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(eventPayload).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  )
  .digest("hex");
const eventAction = (overrides: Record<string, unknown> = {}) =>
  action({
    key: "create_event",
    label: "Create event: Private workshop",
    payload: eventPayload,
    payloadHash: eventDigest,
    preview: {
      title: eventPayload.title,
      summary: "create_event",
      fields: [
        { key: "location", value: "Main studio" },
        { key: "date", value: eventPayload.date },
        { key: "startTime", value: eventPayload.startTime },
        { key: "endTime", value: eventPayload.endTime },
      ],
      warnings: [],
      target: { type: "event", id: null, label: eventPayload.title },
    },
    targetSnapshot: {
      type: "workspace",
      id: LOCATION_ID,
      locationId: LOCATION_ID,
    },
    requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
    requiredModule: "courses",
    riskLevel: "medium",
    locationId: LOCATION_ID,
    ...overrides,
  });

const selectedQuery = (value: unknown) => ({
  select: vi.fn().mockResolvedValue(value),
});

const leanActionQuery = (value: unknown) => ({
  lean: vi.fn().mockResolvedValue(value),
});

const expiringActionQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
  })),
});

const selectedLeanQuery = (value: unknown) => ({
  select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});

const sortedActionQuery = (value: unknown) => ({
  sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
});

const pagedActionQuery = (value: unknown) => ({
  sort: vi.fn(() => ({
    skip: vi.fn(() => ({
      limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
    })),
  })),
});

const sortedEventQuery = (value: unknown) => ({
  sort: vi.fn(() => ({
    select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
  })),
});

describe("AI command intent gate and serialization", () => {
  it.each([
    "Create a task to call the customer",
    "Please complete the clay order task",
    "Could you reorder 12 kg of clay",
    "Vytvoř úkol zavolat zákazníkovi",
    "Prosím objednej 10 kg hlíny",
    'Create an event "Workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
    'Vytvoř událost "Dílna" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
  ])("accepts an explicit command: %s", (message) => {
    expect(isExplicitAiCommandRequest(message)).toBe(true);
  });

  it.each([
    "What would happen if I created a task?",
    "Tell me how reorders work",
    "Do not create a task",
    "Nevytvářej žádný úkol",
    'Dont create an event "Workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
    'Nezakládej akci "Dílna" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
  ])("rejects a non-command or negated request: %s", (message) => {
    expect(isExplicitAiCommandRequest(message)).toBe(false);
  });

  it.each([
    'Create an event "Workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
    'Can you create a private event "Workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
    'Vytvoř událost "Dílna" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
  ])("recognizes an explicit event command: %s", (message) => {
    expect(isExplicitCreateEventCommandRequest(message)).toBe(true);
  });

  it.each([
    "How do I create an event?",
    'Do not create an event "Workshop"',
    'Dont create an event "Workshop"',
    'Nevytvářej událost "Dílna"',
    'Nezakládej akci "Dílna"',
    'Nepřidávej akci "Dílna"',
  ])("rejects informational or negated event intent: %s", (message) => {
    expect(isExplicitCreateEventCommandRequest(message)).toBe(false);
  });

  it("resolves only one exact positive event location clause outside the title", () => {
    const locations = [
      { id: LOCATION_ID, name: "Main studio" },
      { id: "507f1f77bcf86cd799439099", name: "Secret Studio" },
    ];
    expect(
      resolveExplicitEventCommandLocation({
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
        locations,
      }),
    ).toEqual(locations[0]);
    expect(
      resolveExplicitEventCommandLocation({
        message:
          'Vytvoř událost "Dílna" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
        locations,
      }),
    ).toEqual(locations[0]);

    for (const message of [
      'Create an event "Main studio workshop" on 2099-09-15 from 09:00 to 10:00',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Unknown studio',
      'Create an event "Private workshop at Main studio" on 2099-09-15 from 09:00 to 10:00',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 not at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Secret Studio, not at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anywhere other than at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anywhere but at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 everywhere but at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anything but at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at The Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 rather than at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 instead of at Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 unless at Main studio',
      'Vytvoř událost "Dílna" dne 2099-09-15 od 09:00 do 10:00 jinde než v Main studio',
      'Vytvoř událost "Dílna" dne 2099-09-15 od 09:00 do 10:00 kdekoli kromě v Main studio',
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio and at Secret Studio',
    ]) {
      expect(
        resolveExplicitEventCommandLocation({ message, locations }),
        message,
      ).toBeNull();
    }
  });

  it("returns one allowlisted shape without raw payload or internal errors", () => {
    const serialized = serializeAiAction(
      action({
        error: "database hostname and stack",
        requiredPermission: "tasks.manage",
      }),
      USER_ID,
    );

    expect(serialized).toMatchObject({
      id: ACTION_ID,
      conversationId: CONVERSATION_ID,
      status: AI_ACTION_STATUS.SUGGESTED,
      canConfirm: true,
      canDismiss: true,
    });
    expect(serialized).not.toHaveProperty("payload");
    expect(serialized).not.toHaveProperty("tenant");
    expect(serialized).not.toHaveProperty("requiredPermission");
    expect(serialized).not.toHaveProperty("error");
  });

  it("serializes an event result without an unverified navigation route", () => {
    const serialized = serializeAiAction(
      action({
        status: AI_ACTION_STATUS.COMPLETED,
        result: {
          type: "event",
          id: "507f1f77bcf86cd799439099",
          title: "Private workshop",
        },
      }),
      USER_ID,
    );

    expect(serialized.result).toEqual({
      type: "event",
      id: "507f1f77bcf86cd799439099",
      title: "Private workshop",
    });
    expect(serialized.result).not.toHaveProperty("href");
  });

  it("exposes a requester retry only after an execution lease becomes stale", () => {
    const serialized = serializeAiAction(
      action({
        status: AI_ACTION_STATUS.EXECUTING,
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }),
      USER_ID,
    );

    expect(serialized).toMatchObject({
      status: AI_ACTION_STATUS.EXECUTING,
      recoverable: true,
      canConfirm: true,
      canDismiss: false,
    });
  });
});

describe("AI action proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAccess.mockResolvedValue(access());
    mocks.actionCreate.mockImplementation(async (value) => ({
      _id: ACTION_ID,
      createdAt: new Date(),
      ...value,
    }));
    mocks.eventUpdateOne.mockResolvedValue({});
    mocks.resolveSuggestion.mockReturnValue({
      key: "create_task",
      label: "Create task: Call the customer",
      payload,
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      requiredModule: "staff_tasks",
      riskLevel: "low",
      locationId: LOCATION_ID,
      preview: action().preview,
      targetSnapshot: action().targetSnapshot,
    });
  });

  it("persists a server-resolved preview only for a direct command", async () => {
    const result = await persistSuggestedActions({
      context: context(),
      conversationId: CONVERSATION_ID,
      actions: [{ key: "create_task", label: "Misleading label", payload }],
      commandContext,
      currentMessage: "Create a task to call the customer",
      sourceMessageId: MESSAGE_ID,
      runId: "507f1f77bcf86cd799439099",
    });

    expect(result).toHaveLength(1);
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        label: "Create task: Call the customer",
        payload,
        payloadHash: digest,
        preview: action().preview,
      }),
    );
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: TENANT_ID,
        action: ACTION_ID,
        eventKey: "suggested:0",
      }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          type: "suggested",
          actor: USER_ID,
        }),
      }),
      { upsert: true, timestamps: false },
    );
  });

  it("persists an event only when every bounded field is literal and unambiguous", async () => {
    const eventPayload = {
      title: "Private workshop",
      locationId: LOCATION_ID,
      date: "2099-09-15",
      startTime: "09:00",
      endTime: "10:00",
    };
    const eventContext: AiCommandContext = {
      ...commandContext,
      capabilities: [
        {
          key: "create_event",
          requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
          riskLevel: "medium",
        },
      ],
    };
    mocks.resolveSuggestion.mockReturnValue({
      key: "create_event",
      label: "Create event: Private workshop",
      payload: eventPayload,
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredModule: "courses",
      riskLevel: "medium",
      locationId: LOCATION_ID,
      preview: {
        title: eventPayload.title,
        summary: "create_event",
        fields: [],
        warnings: [],
        target: { type: "event", id: null, label: eventPayload.title },
      },
      targetSnapshot: {
        type: "workspace",
        id: LOCATION_ID,
        locationId: LOCATION_ID,
      },
    });

    for (const currentMessage of [
      'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
      'Vytvoř událost "Private workshop" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
    ]) {
      const result = await persistSuggestedActions({
        context: context(),
        conversationId: CONVERSATION_ID,
        actions: [{ key: "create_event", payload: eventPayload }],
        commandContext: eventContext,
        currentMessage,
        sourceMessageId: MESSAGE_ID,
      });
      expect(result, currentMessage).toHaveLength(1);
    }

    expect(mocks.actionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "create_event",
        requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
        requiredModule: "courses",
        locationId: LOCATION_ID,
        payload: eventPayload,
      }),
    );
  });

  it("drops negated, changed, incomplete, and ambiguous event proposals", async () => {
    const eventPayload = {
      title: "Private workshop",
      locationId: LOCATION_ID,
      date: "2099-09-15",
      startTime: "09:00",
      endTime: "10:00",
    };
    const eventContext: AiCommandContext = {
      ...commandContext,
      capabilities: [
        {
          key: "create_event",
          requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
          riskLevel: "medium",
        },
      ],
    };
    const cases: Array<{
      message: string;
      payload?: typeof eventPayload;
      context?: AiCommandContext;
    }> = [
      {
        message:
          'Dont create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
      },
      {
        message:
          'Nezakládej akci "Private workshop" dne 2099-09-15 od 09:00 do 10:00 v Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Secret Studio, not at Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anywhere other than at Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anywhere but at Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 everywhere but at Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 anything but at Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at The Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 rather than at Main studio',
      },
      {
        message:
          'Vytvoř událost "Private workshop" dne 2099-09-15 od 09:00 do 10:00 jinde než v Main studio',
      },
      {
        message:
          'Vytvoř událost "Private workshop" dne 2099-09-15 od 09:00 do 10:00 kdekoli kromě v Main studio',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
        payload: { ...eventPayload, title: "Different title" },
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
        payload: { ...eventPayload, title: "private workshop" },
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
        payload: { ...eventPayload, date: "2099-09-16" },
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00',
      },
      {
        message:
          'Create an event "Main studio workshop" on 2099-09-15 from 09:00 to 10:00',
      },
      {
        message:
          'Create an event "Private workshop" on 2099-09-15 from 09:00 to 10:00 at Main studio',
        context: {
          ...eventContext,
          locations: [
            {
              ...eventContext.locations[0],
              id: "507f1f77bcf86cd799439099",
              name: "Main studio",
            },
            {
              ...eventContext.locations[0],
              id: LOCATION_ID,
              name: "Main studio",
            },
          ],
        },
      },
    ];

    for (const testCase of cases) {
      await expect(
        persistSuggestedActions({
          context: context(),
          conversationId: CONVERSATION_ID,
          actions: [
            {
              key: "create_event",
              payload: testCase.payload || eventPayload,
            },
          ],
          commandContext: testCase.context || eventContext,
          currentMessage: testCase.message,
          sourceMessageId: MESSAGE_ID,
        }),
        testCase.message,
      ).resolves.toEqual([]);
    }
    expect(mocks.actionCreate).not.toHaveBeenCalled();
    expect(mocks.resolveSuggestion).not.toHaveBeenCalled();
  });

  it("drops model-proposed mutations for an informational question", async () => {
    await expect(
      persistSuggestedActions({
        context: context(),
        conversationId: CONVERSATION_ID,
        actions: [{ key: "create_task", payload }],
        commandContext,
        currentMessage: "What would happen if I created this task?",
        sourceMessageId: MESSAGE_ID,
      }),
    ).resolves.toEqual([]);
    expect(mocks.actionCreate).not.toHaveBeenCalled();
  });
});

describe("AI action read authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationExists.mockResolvedValue({ _id: CONVERSATION_ID });
    mocks.resolveAccess.mockResolvedValue(
      access({
        locationAccess: { mode: "selected", locationIds: [LOCATION_ID] },
      }),
    );
    mocks.actionFind
      .mockReturnValueOnce(expiringActionQuery([]))
      .mockReturnValueOnce(sortedActionQuery([]));
  });

  it("reapplies current requester and location scope to conversation actions", async () => {
    await getVisibleConversationAiActions({
      context: context(),
      conversationId: CONVERSATION_ID,
    });

    expect(mocks.actionFind).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        conversation: CONVERSATION_ID,
        $or: [
          { locationId: { $in: [LOCATION_ID] } },
          {
            locationId: null,
            requestedBy: USER_ID,
            key: "complete_task",
          },
        ],
      }),
    );
    expect(mocks.conversationExists).toHaveBeenCalledWith({
      _id: CONVERSATION_ID,
      tenant: TENANT_ID,
      user: USER_ID,
      audience: "workspace",
      status: "active",
      workspaceAccessVersion: 1,
      locationId: { $in: [LOCATION_ID] },
    });
  });

  it("hides saved actions after the requester's access version changes", async () => {
    mocks.resolveAccess.mockResolvedValue(
      access({
        accessVersion: 2,
        locationAccess: { mode: "selected", locationIds: [LOCATION_ID] },
      }),
    );
    mocks.conversationExists.mockResolvedValue(null);

    await expect(
      getVisibleConversationAiActions({
        context: context(),
        conversationId: CONVERSATION_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.conversationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: CONVERSATION_ID,
        workspaceAccessVersion: 2,
      }),
    );
    expect(mocks.actionFind).not.toHaveBeenCalled();
  });

  it("does not expire or audit an action before its parent access boundary passes", async () => {
    mocks.resolveAccess.mockResolvedValue(access({ accessVersion: 2 }));
    mocks.conversationExists.mockResolvedValue(null);
    mocks.actionFindOne.mockReturnValueOnce(leanActionQuery(action()));

    await expect(
      getAiAction({
        context: context(),
        actionId: ACTION_ID,
        scope: "mine",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.conversationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: CONVERSATION_ID,
        workspaceAccessVersion: 2,
      }),
    );
    expect(mocks.actionFind).not.toHaveBeenCalled();
    expect(mocks.actionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.eventUpdateOne).not.toHaveBeenCalled();
  });

  it("returns the persisted expired state after an authorized parent check", async () => {
    const expiredAt = new Date(Date.now() - 60_000);
    const decidedAt = new Date();
    const suggested = action({ expiresAt: expiredAt });
    const expired = action({
      status: AI_ACTION_STATUS.EXPIRED,
      expiresAt: expiredAt,
      decidedAt,
    });
    mocks.actionFind.mockReset();
    mocks.actionFind.mockReturnValueOnce(expiringActionQuery([suggested]));
    mocks.actionFindOne
      .mockReturnValueOnce(leanActionQuery(suggested))
      .mockReturnValueOnce(leanActionQuery(expired));
    mocks.actionFindOneAndUpdate.mockResolvedValueOnce(expired);
    mocks.eventUpdateOne.mockResolvedValue({});
    mocks.eventFind.mockReturnValue(sortedEventQuery([]));

    const result = await getAiAction({
      context: context(),
      actionId: ACTION_ID,
      scope: "mine",
    });

    expect(result.action).toMatchObject({
      status: AI_ACTION_STATUS.EXPIRED,
      decidedAt,
    });
    expect(mocks.conversationExists.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.actionFind.mock.invocationCallOrder[0]!,
    );
  });

  it("limits action lists to current-version parent conversations", async () => {
    mocks.actionFind.mockReset();
    mocks.actionFind
      .mockReturnValueOnce(expiringActionQuery([]))
      .mockReturnValueOnce(pagedActionQuery([]));
    mocks.actionCount.mockResolvedValue(0);
    mocks.conversationDistinct.mockResolvedValue([]);

    const result = await listAiActions({
      context: context(),
      input: { scope: "mine", page: 1, limit: 30 },
    });

    expect(mocks.conversationDistinct).toHaveBeenCalledWith("_id", {
      tenant: TENANT_ID,
      user: USER_ID,
      audience: "workspace",
      status: "active",
      workspaceAccessVersion: 1,
      locationId: { $in: [LOCATION_ID] },
    });
    expect(mocks.actionFind).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        conversation: { $in: [] },
      }),
    );
    expect(result).toMatchObject({ items: [], total: 0, pendingCount: 0 });
  });
});

describe("AI action confirmation and dismissal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.conversationExists.mockResolvedValue({ _id: CONVERSATION_ID });
    mocks.resolveAccess.mockResolvedValue(access());
    mocks.hasPermission.mockReturnValue(true);
    mocks.canAccessLocation.mockReturnValue(true);
    mocks.tenantExists.mockResolvedValue({ _id: TENANT_ID });
    mocks.locationExists.mockResolvedValue({ _id: LOCATION_ID });
    mocks.locationFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: LOCATION_ID,
        booking: { timezone: "Europe/Prague" },
      }),
    );
    mocks.getDefinition.mockReturnValue({
      key: "create_task",
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      requiredModule: "staff_tasks",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.eventUpdateOne.mockResolvedValue({});
    mocks.createTask.mockResolvedValue({
      _id: "507f1f77bcf86cd799439090",
      title: payload.title,
    });
  });

  it("rechecks access, atomically claims, executes once, and returns the safe action", async () => {
    const suggested = action();
    const claimed = action({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
    });
    const completed = action({
      status: AI_ACTION_STATUS.COMPLETED,
      executionAttempts: 1,
      executionVersion: 1,
      result: {
        type: "staff_task",
        id: "507f1f77bcf86cd799439090",
        title: payload.title,
      },
      completedAt: new Date(),
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(claimed))
      .mockResolvedValueOnce(completed);

    const result = await confirmAiAction({
      context: context(),
      conversationId: CONVERSATION_ID,
      actionId: ACTION_ID,
    });

    expect(mocks.resolveAccess).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
    expect(mocks.hasPermission).toHaveBeenCalledWith(
      expect.any(Object),
      WORKSPACE_PERMISSION.TASKS_MANAGE,
    );
    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ACTION_ID,
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        status: AI_ACTION_STATUS.SUGGESTED,
        payloadHash: digest,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AI_ACTION_STATUS.EXECUTING,
        }),
        $inc: { executionAttempts: 1, executionVersion: 1 },
      }),
      { returnDocument: "after" },
    );
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      idempotent: false,
      action: {
        status: AI_ACTION_STATUS.COMPLETED,
        result: {
          type: "staff_task",
          id: "507f1f77bcf86cd799439090",
        },
      },
    });
    expect(result.action).not.toHaveProperty("payload");
  });

  it("replays a completed action without executing the domain mutation again", async () => {
    mocks.actionFindOne.mockReturnValueOnce(
      selectedQuery(
        action({
          status: AI_ACTION_STATUS.COMPLETED,
          result: { type: "staff_task", id: "task-1", title: payload.title },
        }),
      ),
    );

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(result.idempotent).toBe(true);
    expect(mocks.locationExists).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.actionFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reclaims a stale execution lease and safely resumes the action", async () => {
    const stale = action({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    const claimed = action({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 2,
      executionVersion: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const completed = action({
      status: AI_ACTION_STATUS.COMPLETED,
      executionAttempts: 2,
      executionVersion: 2,
      result: {
        type: "staff_task",
        id: "507f1f77bcf86cd799439090",
        title: payload.title,
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(stale));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(claimed))
      .mockResolvedValueOnce(completed);

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: AI_ACTION_STATUS.EXECUTING,
        executionVersion: 1,
        leaseExpiresAt: expect.objectContaining({ $lte: expect.any(Date) }),
      }),
      expect.any(Object),
      { returnDocument: "after" },
    );
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      idempotent: true,
      action: { status: AI_ACTION_STATUS.COMPLETED },
    });
  });

  it("recovers an already-created reorder before revalidating its stock snapshot", async () => {
    const reorderPayload = {
      itemId: "507f1f77bcf86cd799439091",
      locationId: LOCATION_ID,
      requestedQuantity: 10,
      priority: "normal",
      note: "Restock clay",
    };
    const reorderHash = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(reorderPayload).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        ),
      )
      .digest("hex");
    const stale = action({
      key: "create_inventory_reorder_request",
      label: "Request reorder: Stoneware clay",
      payload: reorderPayload,
      payloadHash: reorderHash,
      preview: {
        title: "Stoneware clay",
        summary: "create_inventory_reorder_request",
        fields: [],
        warnings: [],
        target: {
          type: "inventory_item",
          id: reorderPayload.itemId,
          label: "Stoneware clay",
        },
      },
      targetSnapshot: {
        type: "inventory_item",
        id: reorderPayload.itemId,
        locationId: LOCATION_ID,
        updatedAt: "2026-08-03T08:00:00.000Z",
        status: "low_stock",
        currentQuantity: 2,
        minimumQuantity: 5,
      },
      requiredPermission: WORKSPACE_PERMISSION.INVENTORY_MANAGE,
      requiredModule: "inventory",
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    const claimed = action({
      ...stale,
      executionAttempts: 2,
      executionVersion: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const completed = action({
      ...claimed,
      status: AI_ACTION_STATUS.COMPLETED,
      result: {
        type: "inventory_reorder_request",
        id: "507f1f77bcf86cd799439092",
        itemName: "Stoneware clay",
      },
    });
    mocks.getDefinition.mockReturnValue({
      key: "create_inventory_reorder_request",
      requiredPermission: WORKSPACE_PERMISSION.INVENTORY_MANAGE,
      requiredModule: "inventory",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(stale));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(claimed))
      .mockResolvedValueOnce(completed);
    mocks.reorderFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: "507f1f77bcf86cd799439092",
      }),
    });

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.reorderFindOne).toHaveBeenCalledWith({
      tenant: TENANT_ID,
      aiActionId: ACTION_ID,
      item: reorderPayload.itemId,
      location: LOCATION_ID,
    });
    expect(mocks.itemFindOne).not.toHaveBeenCalled();
    expect(mocks.createReorder).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      idempotent: true,
      action: {
        status: AI_ACTION_STATUS.COMPLETED,
        result: {
          type: "inventory_reorder_request",
          id: "507f1f77bcf86cd799439092",
        },
      },
    });
  });

  it("does not overwrite a concurrent confirmation while expiring a stale snapshot", async () => {
    const expiredSnapshot = action({
      expiresAt: new Date(Date.now() - 1_000),
    });
    const concurrentClaim = action({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    mocks.actionFindOne
      .mockReturnValueOnce(selectedQuery(expiredSnapshot))
      .mockReturnValueOnce(selectedQuery(concurrentClaim));
    mocks.actionFindOneAndUpdate.mockReturnValueOnce(selectedQuery(null));

    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ code: "AI_ACTION_IN_PROGRESS" });

    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ACTION_ID,
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        status: AI_ACTION_STATUS.SUGGESTED,
        expiresAt: { $lte: expect.any(Date) },
        executionVersion: 0,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: AI_ACTION_STATUS.EXPIRED }),
      }),
      { returnDocument: "after" },
    );
    expect(expiredSnapshot.save).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("creates a minimal event only after fresh authorization and confirmation", async () => {
    const suggested = eventAction();
    const claimed = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
    });
    const completed = eventAction({
      status: AI_ACTION_STATUS.COMPLETED,
      executionAttempts: 1,
      executionVersion: 1,
      result: {
        type: "event",
        id: EVENT_ID,
        title: eventPayload.title,
      },
    });
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(claimed))
      .mockResolvedValueOnce(completed);
    mocks.eventFindOne.mockResolvedValue(null);
    mocks.createEvent.mockResolvedValue({
      _id: EVENT_ID,
      title: eventPayload.title,
    });

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.resolveAccess).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
    expect(mocks.hasPermission).toHaveBeenCalledWith(
      expect.any(Object),
      WORKSPACE_PERMISSION.COURSES_MANAGE,
    );
    expect(mocks.tenantExists).toHaveBeenCalledWith({
      _id: TENANT_ID,
      "modules.courses": true,
    });
    expect(mocks.locationExists).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(mocks.locationFindOne).toHaveBeenCalledWith({
      _id: LOCATION_ID,
      tenant: TENANT_ID,
      isActive: true,
    });
    expect(mocks.createEvent).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({
        title: eventPayload.title,
        type: "other",
        status: "inquiry",
        location: LOCATION_ID,
        date: expect.any(Date),
        startTime: "09:00",
        endTime: "10:00",
        order: null,
        customerName: "",
        assignedStaff: [],
        bookings: [],
        priceEstimate: 0,
        finalPrice: 0,
        depositPaid: 0,
      }),
      { aiActionId: ACTION_ID },
    );
    expect(result).toMatchObject({
      idempotent: false,
      action: {
        status: AI_ACTION_STATUS.COMPLETED,
        result: { type: "event", id: EVENT_ID },
      },
    });
    expect(result.action.result).not.toHaveProperty("href");
  });

  it("rechecks the event date against the fresh location calendar day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T01:00:00.000Z"));
    try {
      const boundaryPayload = {
        ...eventPayload,
        date: "2026-08-15",
      };
      const boundaryDigest = createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(boundaryPayload).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
          ),
        )
        .digest("hex");
      const suggested = eventAction({
        payload: boundaryPayload,
        payloadHash: boundaryDigest,
      });
      const claimed = eventAction({
        payload: boundaryPayload,
        payloadHash: boundaryDigest,
        status: AI_ACTION_STATUS.EXECUTING,
        executionAttempts: 1,
        executionVersion: 1,
      });
      const failed = eventAction({
        payload: boundaryPayload,
        payloadHash: boundaryDigest,
        status: AI_ACTION_STATUS.FAILED,
        executionAttempts: 1,
        executionVersion: 1,
      });
      mocks.getDefinition.mockReturnValue({
        key: "create_event",
        requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
        requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
        requiredModule: "courses",
        payloadSchema: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
      });
      mocks.locationFindOne.mockReturnValue(
        selectedLeanQuery({
          _id: LOCATION_ID,
          booking: { timezone: "Pacific/Kiritimati" },
        }),
      );
      mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
      mocks.actionFindOneAndUpdate
        .mockReturnValueOnce(selectedQuery(claimed))
        .mockResolvedValueOnce(failed);
      mocks.eventFindOne.mockResolvedValueOnce(null);

      await expect(
        confirmAiAction({ context: context(), actionId: ACTION_ID }),
      ).rejects.toMatchObject({ code: "AI_ACTION_TARGET_CHANGED" });

      expect(mocks.locationFindOne).toHaveBeenCalledWith({
        _id: LOCATION_ID,
        tenant: TENANT_ID,
        isActive: true,
      });
      expect(mocks.createEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the saved action and event payload target different locations", async () => {
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(
      selectedQuery(eventAction({ locationId: "507f1f77bcf86cd799439099" })),
    );

    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.locationFindOne).not.toHaveBeenCalled();
    expect(mocks.eventFindOne).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it("does not mutate an event after permission, module, location, or membership revocation", async () => {
    const setup = () => {
      mocks.getDefinition.mockReturnValue({
        key: "create_event",
        requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
        requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
        requiredModule: "courses",
        payloadSchema: {
          safeParse: (value: unknown) => ({ success: true, data: value }),
        },
      });
      mocks.actionFindOne.mockReturnValueOnce(selectedQuery(eventAction()));
    };

    setup();
    mocks.hasPermission.mockReturnValueOnce(false);
    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.conversationExists.mockResolvedValue({ _id: CONVERSATION_ID });
    mocks.resolveAccess.mockResolvedValue(access());
    mocks.hasPermission.mockReturnValue(true);
    mocks.tenantExists.mockResolvedValue(null);
    setup();
    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.createEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.conversationExists.mockResolvedValue({ _id: CONVERSATION_ID });
    mocks.resolveAccess.mockResolvedValue(
      access({
        locationAccess: { mode: "selected", locationIds: [] },
      }),
    );
    mocks.hasPermission.mockReturnValue(true);
    mocks.tenantExists.mockResolvedValue({ _id: TENANT_ID });
    mocks.canAccessLocation.mockReturnValue(false);
    setup();
    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.createEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.resolveAccess.mockResolvedValue(
      access({ status: "suspended" as any }),
    );
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(eventAction()));
    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.actionFindOne).not.toHaveBeenCalled();
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it("recovers one event after creation succeeds but action completion persistence fails", async () => {
    const suggested = eventAction();
    const firstClaim = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const stale = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    const secondClaim = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 2,
      executionVersion: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const completed = eventAction({
      status: AI_ACTION_STATUS.COMPLETED,
      executionAttempts: 2,
      executionVersion: 2,
      result: { type: "event", id: EVENT_ID, title: eventPayload.title },
    });
    const event = { _id: EVENT_ID, title: eventPayload.title };
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne
      .mockReturnValueOnce(selectedQuery(suggested))
      .mockReturnValueOnce(selectedQuery(stale));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(firstClaim))
      .mockRejectedValueOnce(new Error("action persistence unavailable"))
      .mockReturnValueOnce(selectedQuery(secondClaim))
      .mockResolvedValueOnce(completed);
    mocks.eventFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(event);
    mocks.createEvent.mockResolvedValueOnce(event);

    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toThrow("action persistence unavailable");

    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(
      mocks.actionFindOneAndUpdate.mock.calls.some(
        ([, update]) =>
          (update as any)?.$set?.status === AI_ACTION_STATUS.FAILED,
      ),
    ).toBe(false);

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.eventFindOne).toHaveBeenLastCalledWith(TENANT_ID, ACTION_ID);
    expect(result).toMatchObject({
      idempotent: true,
      action: {
        status: AI_ACTION_STATUS.COMPLETED,
        result: { type: "event", id: EVENT_ID },
      },
    });
  });

  it("reconciles a committed event after an indeterminate create acknowledgement", async () => {
    const suggested = eventAction();
    const claimed = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
    });
    const completed = eventAction({
      status: AI_ACTION_STATUS.COMPLETED,
      executionAttempts: 1,
      executionVersion: 1,
      result: { type: "event", id: EVENT_ID, title: eventPayload.title },
    });
    const event = { _id: EVENT_ID, title: eventPayload.title };
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
    mocks.actionFindOneAndUpdate
      .mockReturnValueOnce(selectedQuery(claimed))
      .mockResolvedValueOnce(completed);
    mocks.eventFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(event);
    mocks.createEvent.mockRejectedValueOnce(
      new Error("connection closed before acknowledgement"),
    );

    const result = await confirmAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.eventFindOne).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      action: {
        status: AI_ACTION_STATUS.COMPLETED,
        result: { type: "event", id: EVENT_ID },
      },
    });
    expect(
      mocks.actionFindOneAndUpdate.mock.calls.some(
        ([, update]) =>
          (update as any)?.$set?.status === AI_ACTION_STATUS.FAILED,
      ),
    ).toBe(false);
  });

  it("leaves an event action recoverable when its initial idempotency lookup is unavailable", async () => {
    const suggested = eventAction();
    const claimed = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
    });
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
    mocks.actionFindOneAndUpdate.mockReturnValueOnce(selectedQuery(claimed));
    mocks.eventFindOne.mockRejectedValueOnce(
      new Error("idempotency lookup unavailable"),
    );

    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({
      code: "AI_ACTION_EXECUTION_OUTCOME_UNKNOWN",
    });

    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(
      mocks.actionFindOneAndUpdate.mock.calls.some(
        ([, update]) =>
          (update as any)?.$set?.status === AI_ACTION_STATUS.FAILED,
      ),
    ).toBe(false);
  });

  it("leaves an event action recoverable when its create outcome cannot be verified", async () => {
    const suggested = eventAction();
    const claimed = eventAction({
      status: AI_ACTION_STATUS.EXECUTING,
      executionAttempts: 1,
      executionVersion: 1,
    });
    mocks.getDefinition.mockReturnValue({
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
      requiredModule: "courses",
      payloadSchema: {
        safeParse: (value: unknown) => ({ success: true, data: value }),
      },
    });
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(suggested));
    mocks.actionFindOneAndUpdate.mockReturnValueOnce(selectedQuery(claimed));
    mocks.eventFindOne
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    mocks.createEvent.mockRejectedValueOnce(
      new Error("connection closed before acknowledgement"),
    );

    await expect(
      confirmAiAction({ context: context(), actionId: ACTION_ID }),
    ).rejects.toMatchObject({
      code: "AI_ACTION_EXECUTION_OUTCOME_UNKNOWN",
    });

    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(
      mocks.actionFindOneAndUpdate.mock.calls.some(
        ([, update]) =>
          (update as any)?.$set?.status === AI_ACTION_STATUS.FAILED,
      ),
    ).toBe(false);
  });

  it("dismisses only the requester's still-pending action with a CAS", async () => {
    const suggested = action();
    const dismissed = action({
      status: AI_ACTION_STATUS.DISMISSED,
      decidedAt: new Date(),
    });
    mocks.actionFindOne.mockResolvedValueOnce(suggested);
    mocks.actionFindOneAndUpdate.mockResolvedValueOnce(dismissed);

    const result = await dismissAiAction({
      context: context(),
      actionId: ACTION_ID,
    });

    expect(mocks.actionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: ACTION_ID,
        tenant: TENANT_ID,
        requestedBy: USER_ID,
        status: AI_ACTION_STATUS.SUGGESTED,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: AI_ACTION_STATUS.DISMISSED,
        }),
      }),
      { returnDocument: "after" },
    );
    expect(result.action.status).toBe(AI_ACTION_STATUS.DISMISSED);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects confirmation when the parent conversation predates current access", async () => {
    mocks.resolveAccess.mockResolvedValue(access({ accessVersion: 2 }));
    mocks.conversationExists.mockResolvedValue(null);
    mocks.actionFindOne.mockReturnValueOnce(selectedQuery(action()));

    await expect(
      confirmAiAction({
        context: context(),
        actionId: ACTION_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.conversationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: CONVERSATION_ID,
        workspaceAccessVersion: 2,
      }),
    );
    expect(mocks.tenantExists).not.toHaveBeenCalled();
    expect(mocks.actionFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects dismissal when the parent conversation predates current access", async () => {
    mocks.resolveAccess.mockResolvedValue(access({ accessVersion: 2 }));
    mocks.conversationExists.mockResolvedValue(null);
    mocks.actionFindOne.mockResolvedValueOnce(action());

    await expect(
      dismissAiAction({
        context: context(),
        actionId: ACTION_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.conversationExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: CONVERSATION_ID,
        workspaceAccessVersion: 2,
      }),
    );
    expect(mocks.actionFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
