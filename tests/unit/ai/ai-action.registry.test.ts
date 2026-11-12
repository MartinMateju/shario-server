import { describe, expect, it, vi } from "vitest";

import { resolveAiActionSuggestion } from "@/modules/ai/services/ai-action.registry.js";
import type { AiCommandContext } from "@/modules/ai/ai-action.types.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f1f77bcf86cd799439012";
const LOCATION_ID = "507f1f77bcf86cd799439013";
const TASK_ID = "507f1f77bcf86cd799439014";
const ITEM_ID = "507f1f77bcf86cd799439015";

const access = (mode: "all" | "selected" = "all"): ResolvedWorkspaceAccess => ({
  membershipId: "507f1f77bcf86cd799439020",
  tenantId: TENANT_ID,
  userId: USER_ID,
  status: "active",
  role: "owner",
  customRoleId: null,
  customRoleName: null,
  permissions: [
    WORKSPACE_PERMISSION.TASKS_MANAGE,
    WORKSPACE_PERMISSION.TASKS_VIEW,
    WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    WORKSPACE_PERMISSION.INVENTORY_VIEW,
    WORKSPACE_PERMISSION.COURSES_MANAGE,
  ],
  locationAccess:
    mode === "all"
      ? { mode: "all", locationIds: [] }
      : { mode: "selected", locationIds: [LOCATION_ID] },
  workspaceProfile: { jobTitle: "", displayName: "", calendarColor: "" },
  preferences: {
    language: null,
    displayTimezone: null,
    defaultLocation: LOCATION_ID,
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
});

const commandContext: AiCommandContext = {
  generatedAt: "2026-08-03T08:00:00.000Z",
  capabilities: [
    {
      key: "create_task",
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      riskLevel: "low",
    },
    {
      key: "complete_task",
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      riskLevel: "low",
    },
    {
      key: "create_inventory_reorder_request",
      requiredPermission: WORKSPACE_PERMISSION.INVENTORY_MANAGE,
      riskLevel: "medium",
    },
    {
      key: "create_event",
      requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
      riskLevel: "medium",
    },
  ],
  assistantCapabilities: {
    readableDomains: ["courses"],
    preparableActions: ["create_event"],
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
  openTasks: [
    {
      id: TASK_ID,
      title: "Call the customer",
      status: "todo",
      locationId: LOCATION_ID,
      locationName: "Main studio",
      appliesToAllLocations: false,
      assignedTo: null,
      updatedAt: "2026-08-03T07:00:00.000Z",
    },
  ],
  lowStockItems: [
    {
      itemId: ITEM_ID,
      itemName: "White clay",
      locationId: LOCATION_ID,
      locationName: "Main studio",
      unit: "kg",
      currentQuantity: 2,
      minimumQuantity: 10,
      suggestedQuantity: 18,
      updatedAt: "2026-08-03T07:30:00.000Z",
    },
  ],
};

describe("AI action registry", () => {
  it("builds the task label and preview on the server", () => {
    const resolved = resolveAiActionSuggestion({
      suggestion: {
        key: "create_task",
        label: "Refund everything",
        payload: {
          title: "Call the customer",
          description: "Confirm collection time.",
          locationId: LOCATION_ID,
          appliesToAllLocations: false,
          dueDate: null,
          priority: "high",
        },
      },
      commandContext,
      access: access(),
    });

    expect(resolved).toMatchObject({
      label: "Create task: Call the customer",
      locationId: LOCATION_ID,
      preview: {
        summary: "create_task",
        target: { type: "workspace", id: LOCATION_ID },
      },
    });
  });

  it("rejects invented targets and an all-location task for selected access", () => {
    expect(
      resolveAiActionSuggestion({
        suggestion: {
          key: "complete_task",
          payload: { taskId: "507f1f77bcf86cd799439099" },
        },
        commandContext,
        access: access(),
      }),
    ).toBeNull();

    expect(
      resolveAiActionSuggestion({
        suggestion: {
          key: "create_task",
          payload: {
            title: "Global cleanup",
            description: "",
            locationId: null,
            appliesToAllLocations: true,
            dueDate: null,
            priority: "normal",
          },
        },
        commandContext,
        access: access("selected"),
      }),
    ).toBeNull();
  });

  it("builds a minimal event preview only for an exact future location", () => {
    const suggestion = {
      key: "create_event" as const,
      payload: {
        title: "Private workshop",
        locationId: LOCATION_ID,
        date: "2099-09-15",
        startTime: "09:00",
        endTime: "10:00",
      },
    };
    expect(
      resolveAiActionSuggestion({
        suggestion,
        commandContext,
        access: access(),
      }),
    ).toMatchObject({
      label: "Create event: Private workshop",
      locationId: LOCATION_ID,
      payload: suggestion.payload,
      preview: {
        summary: "create_event",
        fields: [
          { key: "location", value: "Main studio" },
          { key: "date", value: "2099-09-15" },
          { key: "startTime", value: "09:00" },
          { key: "endTime", value: "10:00" },
          { key: "status", value: "inquiry" },
        ],
        target: { type: "event", id: null },
      },
    });
    expect(
      resolveAiActionSuggestion({
        suggestion: {
          ...suggestion,
          payload: {
            ...suggestion.payload,
            locationId: "507f1f77bcf86cd799439099",
          },
        },
        commandContext,
        access: access(),
      }),
    ).toBeNull();
    expect(
      resolveAiActionSuggestion({
        suggestion: {
          ...suggestion,
          payload: { ...suggestion.payload, date: "2020-09-15" },
        },
        commandContext,
        access: access(),
      }),
    ).toBeNull();
  });

  it("uses the selected location calendar day and fails closed without its timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T01:00:00.000Z"));
    try {
      const suggestion = {
        key: "create_event" as const,
        payload: {
          title: "Boundary workshop",
          locationId: LOCATION_ID,
          date: "2026-08-15",
          startTime: "09:00",
          endTime: "10:00",
        },
      };
      const withTimezone = (timezone: string) => ({
        ...commandContext,
        locations: [
          {
            ...commandContext.locations[0]!,
            booking: {
              ...commandContext.locations[0]!.booking,
              timezone,
            },
          },
        ],
      });

      expect(
        resolveAiActionSuggestion({
          suggestion,
          commandContext: withTimezone("Pacific/Kiritimati"),
          access: access(),
        }),
      ).toBeNull();
      expect(
        resolveAiActionSuggestion({
          suggestion,
          commandContext: withTimezone("America/Adak"),
          access: access(),
        }),
      ).toMatchObject({ key: "create_event", payload: suggestion.payload });
      expect(
        resolveAiActionSuggestion({
          suggestion,
          commandContext: {
            ...commandContext,
            locations: [
              {
                ...commandContext.locations[0]!,
                booking: undefined,
              },
            ],
          } as unknown as AiCommandContext,
          access: access(),
        }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds a reorder to the exact authorized item-location pair", () => {
    const resolved = resolveAiActionSuggestion({
      suggestion: {
        key: "create_inventory_reorder_request",
        payload: {
          itemId: ITEM_ID,
          locationId: LOCATION_ID,
          requestedQuantity: 100,
          priority: "high",
          note: "For the autumn courses",
        },
      },
      commandContext,
      access: access(),
    });

    expect(resolved).toMatchObject({
      label: "Request reorder: White clay",
      targetSnapshot: {
        currentQuantity: 2,
        minimumQuantity: 10,
      },
      preview: {
        warnings: ["quantity_above_suggestion"],
        target: { type: "inventory_item", id: ITEM_ID },
      },
    });
  });
});
