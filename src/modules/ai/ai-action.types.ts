import type { WorkspacePermission } from "@/modules/tenant-access/tenant-access.permissions.js";

import { AI_ACTION_KEY, AI_ACTION_RISK } from "./ai.constants.js";

export type AiActionKey = (typeof AI_ACTION_KEY)[keyof typeof AI_ACTION_KEY];

export type AiActionRisk = (typeof AI_ACTION_RISK)[keyof typeof AI_ACTION_RISK];

export type CreateTaskActionPayload = {
  title: string;
  description: string;
  locationId: string | null;
  appliesToAllLocations: boolean;
  dueDate: string | null;
  priority: "low" | "normal" | "high" | "urgent";
};

export type CompleteTaskActionPayload = {
  taskId: string;
};

export type CreateInventoryReorderActionPayload = {
  itemId: string;
  locationId: string;
  requestedQuantity: number;
  priority: "low" | "medium" | "high";
  note: string;
};

export type CreateEventActionPayload = {
  title: string;
  locationId: string;
  date: string;
  startTime: string;
  endTime: string;
};

export type AiActionPayloadByKey = {
  [AI_ACTION_KEY.CREATE_TASK]: CreateTaskActionPayload;
  [AI_ACTION_KEY.COMPLETE_TASK]: CompleteTaskActionPayload;
  [AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST]: CreateInventoryReorderActionPayload;
  [AI_ACTION_KEY.CREATE_EVENT]: CreateEventActionPayload;
};

export type AiActionPayload = AiActionPayloadByKey[keyof AiActionPayloadByKey];

export type AiActionPreview = {
  title: string;
  summary: string;
  fields: Array<{ key: string; value: string }>;
  warnings: string[];
  target: {
    type: "staff_task" | "inventory_item" | "workspace" | "event";
    id: string | null;
    label: string;
  };
};

export type AssistantCapabilityDomain =
  | "bookings"
  | "customers"
  | "inventory"
  | "memberships"
  | "invoices"
  | "team"
  | "tasks"
  | "communications"
  | "reports"
  | "locations"
  | "products"
  | "courses";

export type AiCommandContext = {
  generatedAt: string;
  capabilities: Array<{
    key: AiActionKey;
    requiredPermission: WorkspacePermission;
    riskLevel: AiActionRisk;
  }>;
  assistantCapabilities: {
    readableDomains: AssistantCapabilityDomain[];
    preparableActions: AiActionKey[];
    bookingComposer: {
      enabled: boolean;
      prefillEnabled: boolean;
      directMutation: false;
    };
  };
  locations: Array<{
    id: string;
    name: string;
    booking: {
      enabled: boolean;
      timezone: string;
      slotStepMinutes: number;
      minBookingMinutes: number;
      maxBookingMinutes: number;
    };
    openingHours: Record<
      string,
      {
        isOpen?: boolean;
        openTime?: string;
        closeTime?: string;
      }
    >;
  }>;
  bookingProducts: Array<{
    id: string;
    name: string;
    kind: "class" | "private-studio";
  }>;
  openTasks: Array<{
    id: string;
    title: string;
    status: string;
    locationId: string | null;
    locationName: string | null;
    appliesToAllLocations: boolean;
    assignedTo: string | null;
    updatedAt: string;
  }>;
  lowStockItems: Array<{
    itemId: string;
    itemName: string;
    locationId: string;
    locationName: string;
    unit: string;
    currentQuantity: number;
    minimumQuantity: number;
    suggestedQuantity: number;
    updatedAt: string;
  }>;
};

export type AiActionTargetSnapshot = {
  type: "staff_task" | "inventory_item" | "workspace";
  id: string | null;
  locationId: string | null;
  updatedAt: string | null;
  status: string | null;
  currentQuantity: number | null;
  minimumQuantity: number | null;
};

export type SuggestedAiAction = {
  [Key in keyof AiActionPayloadByKey]: {
    key: Key;
    label?: string;
    payload: AiActionPayloadByKey[Key];
  };
}[keyof AiActionPayloadByKey];

