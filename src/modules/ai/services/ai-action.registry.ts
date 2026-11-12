import type { ZodType } from "zod";

import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import { AI_ACTION_KEY, AI_ACTION_RISK } from "../ai.constants.js";
import type {
  AiActionKey,
  AiActionPayload,
  AiActionPreview,
  AiActionTargetSnapshot,
  AiCommandContext,
  SuggestedAiAction,
} from "../ai-action.types.js";
import { isFutureCalendarDateInTimeZone } from "./event-calendar-date.js";

import {
  completeTaskActionPayloadSchema,
  createEventActionPayloadSchema,
  createInventoryReorderActionPayloadSchema,
  createTaskActionPayloadSchema,
} from "../ai.validators.js";

type AiActionDefinition = {
  key: AiActionKey;
  requiredPermission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION];
  requiredPermissions: Array<
    (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION]
  >;
  requiredModule: (typeof TENANT_MODULE)[keyof typeof TENANT_MODULE];
  riskLevel: (typeof AI_ACTION_RISK)[keyof typeof AI_ACTION_RISK];
  payloadSchema: ZodType;
};

export const AI_ACTION_REGISTRY: Record<AiActionKey, AiActionDefinition> = {
  [AI_ACTION_KEY.CREATE_TASK]: {
    key: AI_ACTION_KEY.CREATE_TASK,
    requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
    requiredPermissions: [WORKSPACE_PERMISSION.TASKS_MANAGE],
    requiredModule: TENANT_MODULE.STAFF_TASKS,
    riskLevel: AI_ACTION_RISK.LOW,
    payloadSchema: createTaskActionPayloadSchema,
  },
  [AI_ACTION_KEY.COMPLETE_TASK]: {
    key: AI_ACTION_KEY.COMPLETE_TASK,
    requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
    requiredPermissions: [
      WORKSPACE_PERMISSION.TASKS_VIEW,
      WORKSPACE_PERMISSION.TASKS_MANAGE,
    ],
    requiredModule: TENANT_MODULE.STAFF_TASKS,
    riskLevel: AI_ACTION_RISK.LOW,
    payloadSchema: completeTaskActionPayloadSchema,
  },
  [AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST]: {
    key: AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST,
    requiredPermission: WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    requiredPermissions: [
      WORKSPACE_PERMISSION.INVENTORY_VIEW,
      WORKSPACE_PERMISSION.INVENTORY_MANAGE,
    ],
    requiredModule: TENANT_MODULE.INVENTORY,
    riskLevel: AI_ACTION_RISK.MEDIUM,
    payloadSchema: createInventoryReorderActionPayloadSchema,
  },
  [AI_ACTION_KEY.CREATE_EVENT]: {
    key: AI_ACTION_KEY.CREATE_EVENT,
    requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
    requiredPermissions: [WORKSPACE_PERMISSION.COURSES_MANAGE],
    requiredModule: TENANT_MODULE.COURSES,
    riskLevel: AI_ACTION_RISK.MEDIUM,
    payloadSchema: createEventActionPayloadSchema,
  },
};

export const getAiActionDefinition = (key: unknown) =>
  typeof key === "string"
    ? AI_ACTION_REGISTRY[key as AiActionKey] || null
    : null;

const cleanText = (value: unknown, maxLength: number) =>
  String(value ?? "")
    .trim()
    .slice(0, maxLength);

const displayDate = (value: string | null) =>
  value ? new Date(value).toISOString() : "none";

export type ResolvedAiActionSuggestion = {
  key: AiActionKey;
  label: string;
  payload: AiActionPayload;
  requiredPermission: AiActionDefinition["requiredPermission"];
  requiredModule: AiActionDefinition["requiredModule"];
  riskLevel: AiActionDefinition["riskLevel"];
  locationId: string | null;
  preview: AiActionPreview;
  targetSnapshot: AiActionTargetSnapshot;
};

export const resolveAiActionSuggestion = ({
  suggestion,
  commandContext,
  access,
}: {
  suggestion: SuggestedAiAction;
  commandContext: AiCommandContext;
  access: ResolvedWorkspaceAccess;
}): ResolvedAiActionSuggestion | null => {
  const definition = getAiActionDefinition(suggestion.key);
  if (!definition) return null;
  if (
    definition.requiredPermissions.some(
      (permission) =>
        access.status !== "active" || !access.permissions.includes(permission),
    )
  ) {
    return null;
  }
  if (!commandContext.capabilities.some(({ key }) => key === suggestion.key)) {
    return null;
  }
  const parsed = definition.payloadSchema.safeParse(suggestion.payload);
  if (!parsed.success) return null;

  if (suggestion.key === AI_ACTION_KEY.CREATE_TASK) {
    const payload = createTaskActionPayloadSchema.parse(parsed.data);
    const location = payload.locationId
      ? commandContext.locations.find(({ id }) => id === payload.locationId)
      : null;
    if (payload.locationId && !location) return null;
    if (payload.appliesToAllLocations && access.locationAccess.mode !== "all") {
      return null;
    }
    const scopeLabel = payload.appliesToAllLocations
      ? "all_locations"
      : location?.name || "";
    const safePayload = {
      ...payload,
      title: cleanText(payload.title, 180),
      description: cleanText(payload.description, 3_000),
    };
    return {
      key: suggestion.key,
      label: `Create task: ${safePayload.title}`,
      payload: safePayload,
      requiredPermission: definition.requiredPermission,
      requiredModule: definition.requiredModule,
      riskLevel: definition.riskLevel,
      locationId: payload.locationId,
      preview: {
        title: safePayload.title,
        summary: AI_ACTION_KEY.CREATE_TASK,
        fields: [
          { key: "scope", value: scopeLabel },
          { key: "priority", value: payload.priority },
          { key: "dueDate", value: displayDate(payload.dueDate) },
          ...(safePayload.description
            ? [{ key: "description", value: safePayload.description }]
            : []),
        ],
        warnings: payload.appliesToAllLocations ? ["all_locations"] : [],
        target: {
          type: "workspace",
          id: payload.locationId,
          label: scopeLabel,
        },
      },
      targetSnapshot: {
        type: "workspace",
        id: payload.locationId,
        locationId: payload.locationId,
        updatedAt: null,
        status: null,
        currentQuantity: null,
        minimumQuantity: null,
      },
    };
  }

  if (suggestion.key === AI_ACTION_KEY.COMPLETE_TASK) {
    const payload = completeTaskActionPayloadSchema.parse(parsed.data);
    const task = commandContext.openTasks.find(
      ({ id }) => id === payload.taskId,
    );
    if (!task) return null;
    return {
      key: suggestion.key,
      label: `Complete task: ${task.title}`,
      payload,
      requiredPermission: definition.requiredPermission,
      requiredModule: definition.requiredModule,
      riskLevel: definition.riskLevel,
      locationId: task.locationId,
      preview: {
        title: task.title,
        summary: AI_ACTION_KEY.COMPLETE_TASK,
        fields: [
          { key: "currentStatus", value: task.status },
          {
            key: "scope",
            value: task.appliesToAllLocations
              ? "all_locations"
              : task.locationName || task.locationId || "",
          },
        ],
        warnings: [],
        target: { type: "staff_task", id: task.id, label: task.title },
      },
      targetSnapshot: {
        type: "staff_task",
        id: task.id,
        locationId: task.locationId,
        updatedAt: task.updatedAt,
        status: task.status,
        currentQuantity: null,
        minimumQuantity: null,
      },
    };
  }

  if (suggestion.key === AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST) {
    const payload = createInventoryReorderActionPayloadSchema.parse(
      parsed.data,
    );
    const item = commandContext.lowStockItems.find(
      (candidate) =>
        candidate.itemId === payload.itemId &&
        candidate.locationId === payload.locationId,
    );
    if (!item) return null;
    const requestedQuantity = Number(payload.requestedQuantity);
    return {
      key: suggestion.key,
      label: `Request reorder: ${item.itemName}`,
      payload: { ...payload, requestedQuantity },
      requiredPermission: definition.requiredPermission,
      requiredModule: definition.requiredModule,
      riskLevel: definition.riskLevel,
      locationId: item.locationId,
      preview: {
        title: item.itemName,
        summary: AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST,
        fields: [
          { key: "location", value: item.locationName },
          {
            key: "currentStock",
            value: `${item.currentQuantity} ${item.unit}`.trim(),
          },
          {
            key: "minimumStock",
            value: `${item.minimumQuantity} ${item.unit}`.trim(),
          },
          {
            key: "requestedQuantity",
            value: `${requestedQuantity} ${item.unit}`.trim(),
          },
          { key: "priority", value: payload.priority },
          ...(payload.note
            ? [{ key: "note", value: cleanText(payload.note, 2_000) }]
            : []),
        ],
        warnings:
          requestedQuantity > Math.max(item.suggestedQuantity * 5, 1)
            ? ["quantity_above_suggestion"]
            : [],
        target: {
          type: "inventory_item",
          id: item.itemId,
          label: item.itemName,
        },
      },
      targetSnapshot: {
        type: "inventory_item",
        id: item.itemId,
        locationId: item.locationId,
        updatedAt: item.updatedAt,
        status: "low_stock",
        currentQuantity: item.currentQuantity,
        minimumQuantity: item.minimumQuantity,
      },
    };
  }

  if (suggestion.key === AI_ACTION_KEY.CREATE_EVENT) {
    const payload = createEventActionPayloadSchema.parse(parsed.data);
    const location = commandContext.locations.find(
      ({ id }) => id === payload.locationId,
    );
    if (
      !location ||
      !isFutureCalendarDateInTimeZone({
        date: payload.date,
        timeZone: location.booking?.timezone || "",
      })
    ) {
      return null;
    }
    const safePayload = {
      ...payload,
      title: cleanText(payload.title, 160),
    };
    return {
      key: suggestion.key,
      label: `Create event: ${safePayload.title}`,
      payload: safePayload,
      requiredPermission: definition.requiredPermission,
      requiredModule: definition.requiredModule,
      riskLevel: definition.riskLevel,
      locationId: payload.locationId,
      preview: {
        title: safePayload.title,
        summary: AI_ACTION_KEY.CREATE_EVENT,
        fields: [
          { key: "location", value: location.name },
          { key: "date", value: payload.date },
          { key: "startTime", value: payload.startTime },
          { key: "endTime", value: payload.endTime },
          { key: "status", value: "inquiry" },
        ],
        warnings: [],
        target: {
          type: "event",
          id: null,
          label: safePayload.title,
        },
      },
      targetSnapshot: {
        type: "workspace",
        id: payload.locationId,
        locationId: payload.locationId,
        updatedAt: null,
        status: null,
        currentQuantity: null,
        minimumQuantity: null,
      },
    };
  }

  return null;
};
