import { createHash } from "node:crypto";

import { EVENT_STATUS, EVENT_TYPE } from "@/modules/event/event.constants.js";
import { eventRepository } from "@/modules/event/event.repository.js";
import { eventService } from "@/modules/event/services/event.service.js";
import { createEventSchema } from "@/modules/event/event.validators.js";
import { InventoryItem } from "@/modules/inventory/inventory.model.js";
import { ReorderRequest } from "@/modules/inventory/reorder-request.schema.js";
import { inventoryService } from "@/modules/inventory/services/inventory.service.js";
import { createReorderRequestSchema } from "@/modules/inventory/inventory.validators.js";
import LocationModel from "@/modules/location/location.model.js";
import { STAFF_TASK_STATUS } from "@/modules/staff/staff.constants.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import { staffTaskService } from "@/modules/staff/services/staff-task.service.js";
import { createStaffTaskSchema } from "@/modules/staff/staff.validators.js";
import { isFutureCalendarDateInTimeZone } from "./event-calendar-date.js";

import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { conflict, forbidden, notFound } from "@/shared/http/httpErrors.js";

import {
  AI_ACTION_EVENT,
  AI_ACTION_EXECUTION_LEASE_MS,
  AI_ACTION_KEY,
  AI_ACTION_SCHEMA_VERSION,
  AI_ACTION_STATUS,
  AI_ACTION_TTL_MS,
} from "../ai.constants.js";
import {
  AiActionEventModel,
  AiActionModel,
  AiConversationModel,
} from "../ai.models.js";
import type {
  AiActionPreview,
  AiCommandContext,
  SuggestedAiAction,
} from "../ai-action.types.js";
import type { AiRequestContext } from "../ai.types.js";
import {
  getAiActionDefinition,
  resolveAiActionSuggestion,
} from "./ai-action.registry.js";

type AiActionListInput = {
  scope: "mine" | "workspace";
  status?: string;
  page: number;
  limit: number;
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const payloadHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 11000,
  );

class RecoverableAiActionExecutionError extends Error {
  readonly code = "AI_ACTION_EXECUTION_OUTCOME_UNKNOWN";

  constructor(message: string) {
    super(message);
    this.name = "RecoverableAiActionExecutionError";
  }
}

const errorCode = (error: unknown) => {
  if (error && typeof error === "object" && "code" in error) {
    return String(
      (error as { code?: unknown }).code || "AI_ACTION_EXECUTION_FAILED",
    )
      .trim()
      .slice(0, 120);
  }
  return "AI_ACTION_EXECUTION_FAILED";
};

const normalizeCommand = (value: string) =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const commandVerb =
  "(?:create|add|make|complete|finish|mark|request|order|reorder|vytvor|zaloz|pridej|dokonc|oznac|objednej|vystav)";

export const isExplicitCreateEventCommandRequest = (
  message: string,
): boolean => {
  const normalized = normalizeCommand(message);
  if (
    !normalized ||
    /\b(?:do not|don't|dont|neprovadej|nedel|nevytvarej|nezakladej|nepridavej)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /^(?:please )?(?:create|add|make)\s+(?:(?:an?|the|new|studio|private)\s+)*(?:event)\b/.test(
      normalized,
    ) ||
    /^(?:can|could|would|will) you (?:please )?(?:create|add|make)\s+(?:(?:an?|the|new|studio|private)\s+)*(?:event)\b/.test(
      normalized,
    ) ||
    /^(?:prosim )?(?:vytvor|zaloz|pridej)(?: mi)?\s+(?:(?:novou|studio)\s+)*(?:udalost|akci)\b/.test(
      normalized,
    )
  );
};

const normalizedSearchText = (value: string) =>
  normalizeCommand(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const resolveExplicitEventCommandLocation = ({
  message,
  locations,
}: {
  message: string;
  locations: ReadonlyArray<{ id: string; name: string }>;
}): { id: string; name: string } | null => {
  const outsideQuotedTitle = normalizedSearchText(
    message.replace(/["“„]([^"“”„]{1,160})["”]/gu, " "),
  );
  if (
    !outsideQuotedTitle ||
    /\b(?:not|never|no|dont|don t|except|excluding|without|other than|anything but|anywhere other than|anywhere but|everywhere but|nikoli|ne|mimo|krome|bez|jinde nez|kdekoli krome)\b/.test(
      outsideQuotedTitle,
    )
  ) {
    return null;
  }

  const introducers =
    outsideQuotedTitle.match(/\b(?:at|in|for|v|ve|na)\b/g) || [];
  if (introducers.length !== 1) return null;

  const matchingLocations = locations.filter(({ name }) => {
    const needle = normalizedSearchText(name);
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|\\s)(?:from|od)\\s+(?:[01]\\d|2[0-3])\\s+[0-5]\\d\\s+(?:(?:to|do)\\s+)?(?:[01]\\d|2[0-3])\\s+[0-5]\\d\\s+(?:at|in|for|v|ve|na)\\s+${escaped}$`,
    ).test(outsideQuotedTitle);
  });
  return matchingLocations.length === 1 ? matchingLocations[0]! : null;
};

const isLiteralEventPayload = ({
  message,
  payload,
  commandContext,
}: {
  message: string;
  payload: any;
  commandContext: AiCommandContext;
}): boolean => {
  const quotedTitles = Array.from(
    message.matchAll(/["“„]([^"“”„]{1,160})["”]/gu),
    (match) => String(match[1] || "").trim(),
  );
  if (
    quotedTitles.length !== 1 ||
    quotedTitles[0] !== String(payload.title).trim()
  ) {
    return false;
  }
  const dates = Array.from(
    message.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g),
    (match) => String(match[1] || ""),
  );
  const timeRanges = Array.from(
    message.matchAll(
      /\b(?:from|od)\s+(([01]\d|2[0-3]):[0-5]\d)\s+(?:to|do|[-–])\s+(([01]\d|2[0-3]):[0-5]\d)\b/giu,
    ),
    (match) => ({
      startTime: String(match[1] || ""),
      endTime: String(match[3] || ""),
    }),
  );
  if (
    dates.length !== 1 ||
    dates[0] !== payload.date ||
    timeRanges.length !== 1 ||
    timeRanges[0]!.startTime !== payload.startTime ||
    timeRanges[0]!.endTime !== payload.endTime
  ) {
    return false;
  }
  const location = resolveExplicitEventCommandLocation({
    message,
    locations: commandContext.locations,
  });
  return location?.id === payload.locationId;
};

export const isExplicitAiCommandRequest = (message: string): boolean => {
  const normalized = normalizeCommand(message);
  if (
    !normalized ||
    /\b(?:do not|don't|dont|neprovadej|nedel|nevytvarej|nezakladej|nepridavej)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    new RegExp(`^(?:please )?${commandVerb}\\b`).test(normalized) ||
    new RegExp(
      `^(?:can|could|would|will) you (?:please )?${commandVerb}\\b`,
    ).test(normalized) ||
    new RegExp(
      `^(?:i want you to|potrebuji abys|prosim) ${commandVerb}\\b`,
    ).test(normalized)
  );
};

const safePreview = (value: unknown): AiActionPreview => {
  const preview =
    value && typeof value === "object" ? (value as Record<string, any>) : {};
  const target =
    preview.target && typeof preview.target === "object" ? preview.target : {};
  return {
    title: String(preview.title || "").slice(0, 300),
    summary: String(preview.summary || "").slice(0, 500),
    fields: (Array.isArray(preview.fields) ? preview.fields : [])
      .slice(0, 12)
      .map((field: any) => ({
        key: String(field?.key || "").slice(0, 80),
        value: String(field?.value || "").slice(0, 3_000),
      }))
      .filter(({ key }) => Boolean(key)),
    warnings: (Array.isArray(preview.warnings) ? preview.warnings : [])
      .slice(0, 8)
      .map((warning: unknown) => String(warning).slice(0, 120)),
    target: {
      type: ["staff_task", "inventory_item", "workspace", "event"].includes(
        target.type,
      )
        ? target.type
        : "workspace",
      id: target.id ? String(target.id) : null,
      label: String(target.label || "").slice(0, 200),
    },
  };
};

const safeResult = (value: unknown) => {
  const result =
    value && typeof value === "object" ? (value as Record<string, any>) : null;
  if (!result) return null;
  if (result.type === "staff_task") {
    return {
      type: "staff_task",
      id: String(result.id || ""),
      title: String(result.title || "").slice(0, 180),
      href: "/app/staff-planning",
    };
  }
  if (result.type === "inventory_reorder_request") {
    return {
      type: "inventory_reorder_request",
      id: String(result.id || ""),
      itemName: String(result.itemName || "").slice(0, 160),
      href: "/app/inventory",
    };
  }
  if (result.type === "event") {
    return {
      type: "event",
      id: String(result.id || ""),
      title: String(result.title || "").slice(0, 160),
    };
  }
  return null;
};

export const serializeAiAction = (action: any, actorId?: string | null) => {
  const requestedBy = String(
    action.requestedBy?._id ?? action.requestedBy ?? "",
  );
  const expired =
    action.status === AI_ACTION_STATUS.SUGGESTED &&
    new Date(action.expiresAt).getTime() <= Date.now();
  const status = expired ? AI_ACTION_STATUS.EXPIRED : action.status;
  const isRequester = Boolean(actorId && requestedBy === String(actorId));
  const recoverable = Boolean(
    isRequester &&
      status === AI_ACTION_STATUS.EXECUTING &&
      action.leaseExpiresAt &&
      new Date(action.leaseExpiresAt).getTime() <= Date.now(),
  );
  return {
    id: String(action._id),
    conversationId: String(action.conversation),
    key: String(action.key),
    label: String(action.label || "").slice(0, 200),
    status,
    riskLevel: action.riskLevel || "low",
    requiresConfirmation: true,
    canConfirm:
      isRequester && (status === AI_ACTION_STATUS.SUGGESTED || recoverable),
    canDismiss: isRequester && status === AI_ACTION_STATUS.SUGGESTED,
    recoverable,
    preview: safePreview(action.preview),
    requestedBy,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    decidedAt: action.decidedAt || null,
    completedAt: action.completedAt || null,
    result: safeResult(action.result),
    errorCode: action.errorCode || null,
  };
};

const recordEvent = async ({
  action,
  actorId,
  type,
  fromStatus,
  toStatus,
  metadata = {},
}: {
  action: any;
  actorId: string;
  type: (typeof AI_ACTION_EVENT)[keyof typeof AI_ACTION_EVENT];
  fromStatus: string;
  toStatus: string;
  metadata?: Record<string, unknown>;
}) => {
  const eventKey = `${type}:${Number(action.executionVersion || 0)}`;
  const recordedAt = new Date();
  return AiActionEventModel.updateOne(
    { tenant: action.tenant, action: action._id, eventKey },
    {
      $setOnInsert: {
        tenant: action.tenant,
        action: action._id,
        conversation: action.conversation,
        actor: actorId,
        eventKey,
        type,
        fromStatus,
        toStatus,
        metadata,
        createdAt: recordedAt,
        updatedAt: recordedAt,
      },
    },
    { upsert: true, timestamps: false },
  );
};

const requireActor = (context: AiRequestContext): string => {
  if (!context.userId)
    forbidden("An authenticated workspace user is required.");
  return context.userId;
};

const freshAccess = async (
  context: AiRequestContext,
): Promise<ResolvedWorkspaceAccess> => {
  const userId = requireActor(context);
  const access = await resolveWorkspaceAccessForUser({
    tenantId: context.tenantId,
    userId,
  });
  if (!access || access.status !== "active") {
    forbidden({
      message: "Active workspace access is required.",
      code: "WORKSPACE_ACCESS_REQUIRED",
    });
  }
  return access;
};

const assertDefinitionAccess = async ({
  context,
  access,
  action,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  action: any;
}) => {
  const definition = getAiActionDefinition(action.key);
  if (!definition) {
    forbidden({
      message: "This AI action is not supported.",
      code: "AI_ACTION_UNSUPPORTED",
    });
  }
  const requiredPermissions = definition.requiredPermissions || [
    definition.requiredPermission,
  ];
  const missingPermissions = requiredPermissions.filter(
    (permission) => !hasWorkspacePermission(access, permission),
  );
  if (missingPermissions.length) {
    forbidden({
      message: "The required workspace permission is no longer available.",
      code: "WORKSPACE_PERMISSION_REQUIRED",
      details: { requiredPermissions: missingPermissions },
    });
  }
  const moduleEnabled = await TenantModel.exists({
    _id: context.tenantId,
    [`modules.${definition.requiredModule}`]: true,
  });
  if (!moduleEnabled) {
    forbidden({
      message: "The required workspace module is no longer enabled.",
      code: "TENANT_MODULE_REQUIRED",
      details: { requiredModule: definition.requiredModule },
    });
  }
  if (
    action.key === AI_ACTION_KEY.CREATE_EVENT &&
    String(action.locationId || "") !== String(action.payload?.locationId || "")
  ) {
    notFound("AI action not found.");
  }
  if (action.locationId) {
    if (!canAccessWorkspaceLocation(access, String(action.locationId))) {
      notFound("AI action not found.");
    }
    const locationExists = await LocationModel.exists({
      _id: action.locationId,
      tenant: context.tenantId,
      isActive: true,
    });
    if (!locationExists) notFound("AI action not found.");
  }
  if (
    action.key === AI_ACTION_KEY.CREATE_TASK &&
    action.payload?.appliesToAllLocations === true &&
    access.locationAccess.mode !== "all"
  ) {
    notFound("AI action not found.");
  }
  if (
    action.key === AI_ACTION_KEY.COMPLETE_TASK &&
    !action.locationId &&
    action.payload?.taskId
  ) {
    const task = await StaffTaskModel.findOne({
      _id: action.payload.taskId,
      tenantId: context.tenantId,
    } as never)
      .select("locationId appliesToAllLocations assignedTo")
      .lean();
    assertTaskTarget(context, access, task);
  }
  return definition;
};

const actionLocationFilter = (
  access: ResolvedWorkspaceAccess,
  actorId: string,
) =>
  access.locationAccess.mode === "all"
    ? {}
    : {
        $or: [
          { locationId: { $in: access.locationAccess.locationIds } },
          {
            locationId: null,
            requestedBy: actorId,
            key: AI_ACTION_KEY.COMPLETE_TASK,
          },
        ],
      };

const actionConversationLocationFilter = (
  access: ResolvedWorkspaceAccess,
): Record<string, unknown> =>
  access.locationAccess.mode === "all"
    ? {}
    : { locationId: { $in: access.locationAccess.locationIds } };

/**
 * Saved action previews are part of their parent workspace conversation's
 * authorization boundary. Owner-facing reads and mutations must therefore
 * fail closed when the requester's membership access version changes. The
 * explicit workspace audit scope keeps its cross-user semantics, but still
 * excludes deleted/inactive or out-of-location parent conversations.
 */
const currentActionConversationFilter = ({
  context,
  access,
  scope,
  conversationId,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  scope: "mine" | "workspace";
  conversationId?: string;
}): Record<string, unknown> => {
  const actorId = requireActor(context);
  return {
    ...(conversationId ? { _id: conversationId } : {}),
    tenant: context.tenantId,
    audience: "workspace",
    status: "active",
    ...(scope === "mine"
      ? {
          user: actorId,
          workspaceAccessVersion: access.accessVersion,
        }
      : {}),
    ...actionConversationLocationFilter(access),
  };
};

const assertCurrentActionConversation = async ({
  context,
  access,
  conversationId,
  scope = "mine",
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  conversationId: string;
  scope?: "mine" | "workspace";
}): Promise<void> => {
  const conversation = await AiConversationModel.exists(
    currentActionConversationFilter({
      context,
      access,
      scope,
      conversationId,
    }),
  );
  if (!conversation) notFound("AI action not found.");
};

const visibleActionConversationIds = async ({
  context,
  access,
  scope,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  scope: "mine" | "workspace";
}): Promise<unknown[]> =>
  AiConversationModel.distinct(
    "_id",
    currentActionConversationFilter({ context, access, scope }),
  );

const expireSuggestedActions = async (filter: Record<string, unknown>) => {
  const now = new Date();
  const candidates = await AiActionModel.find({
    ...filter,
    status: AI_ACTION_STATUS.SUGGESTED,
    expiresAt: { $lte: now },
  })
    .select("tenant conversation requestedBy executionVersion")
    .limit(200)
    .lean();
  for (const candidate of candidates) {
    const expired = await AiActionModel.findOneAndUpdate(
      {
        _id: candidate._id,
        tenant: candidate.tenant,
        status: AI_ACTION_STATUS.SUGGESTED,
        expiresAt: { $lte: now },
      },
      {
        $set: {
          status: AI_ACTION_STATUS.EXPIRED,
          decidedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (expired) {
      await recordEvent({
        action: expired,
        actorId: String(expired.requestedBy),
        type: AI_ACTION_EVENT.EXPIRED,
        fromStatus: AI_ACTION_STATUS.SUGGESTED,
        toStatus: AI_ACTION_STATUS.EXPIRED,
      });
    }
  }
};

const ensureTerminalEvent = async (action: any) => {
  const transitions: Record<
    string,
    {
      type: (typeof AI_ACTION_EVENT)[keyof typeof AI_ACTION_EVENT];
      fromStatus: string;
    }
  > = {
    [AI_ACTION_STATUS.COMPLETED]: {
      type: AI_ACTION_EVENT.COMPLETED,
      fromStatus: AI_ACTION_STATUS.EXECUTING,
    },
    [AI_ACTION_STATUS.FAILED]: {
      type: AI_ACTION_EVENT.FAILED,
      fromStatus: AI_ACTION_STATUS.EXECUTING,
    },
    [AI_ACTION_STATUS.DISMISSED]: {
      type: AI_ACTION_EVENT.DISMISSED,
      fromStatus: AI_ACTION_STATUS.SUGGESTED,
    },
    [AI_ACTION_STATUS.EXPIRED]: {
      type: AI_ACTION_EVENT.EXPIRED,
      fromStatus: AI_ACTION_STATUS.SUGGESTED,
    },
  };
  const transition = transitions[action.status];
  if (!transition) return;
  await recordEvent({
    action,
    actorId: String(action.requestedBy),
    type: transition.type,
    fromStatus: transition.fromStatus,
    toStatus: action.status,
    metadata:
      action.status === AI_ACTION_STATUS.FAILED && action.errorCode
        ? { errorCode: String(action.errorCode) }
        : {},
  });
};

export const persistSuggestedActions = async ({
  context,
  conversationId,
  actions,
  commandContext,
  currentMessage,
  sourceMessageId,
  runId,
}: {
  context: AiRequestContext;
  conversationId: string;
  actions: SuggestedAiAction[];
  commandContext: AiCommandContext;
  currentMessage: string;
  sourceMessageId: string;
  runId?: string | null;
}) => {
  if (
    !context.userId ||
    !actions.length ||
    !isExplicitAiCommandRequest(currentMessage)
  ) {
    return [];
  }
  const access =
    context.access ??
    (await resolveWorkspaceAccessForUser({
      tenantId: context.tenantId,
      userId: context.userId,
    }));
  if (!access || access.status !== "active") return [];

  const records: any[] = [];
  for (const suggestion of actions.slice(0, 3)) {
    if (
      suggestion.key === AI_ACTION_KEY.CREATE_EVENT &&
      (!isExplicitCreateEventCommandRequest(currentMessage) ||
        !isLiteralEventPayload({
          message: currentMessage,
          payload: suggestion.payload,
          commandContext,
        }))
    ) {
      continue;
    }
    const resolved = resolveAiActionSuggestion({
      suggestion,
      commandContext,
      access,
    });
    if (!resolved) continue;
    const digest = payloadHash(resolved.payload);
    const idempotencyKey = [
      "assistant-action",
      sourceMessageId,
      resolved.key,
      digest,
    ].join(":");
    try {
      const action = await AiActionModel.create({
        tenant: context.tenantId,
        conversation: conversationId,
        requestedBy: context.userId,
        sourceMessage: sourceMessageId,
        run: runId || null,
        key: resolved.key,
        label: resolved.label,
        schemaVersion: AI_ACTION_SCHEMA_VERSION,
        idempotencyKey,
        payload: resolved.payload,
        payloadHash: digest,
        preview: resolved.preview,
        targetSnapshot: resolved.targetSnapshot,
        requiredPermission: resolved.requiredPermission,
        requiredModule: resolved.requiredModule,
        riskLevel: resolved.riskLevel,
        locationId: resolved.locationId,
        status: AI_ACTION_STATUS.SUGGESTED,
        expiresAt: new Date(Date.now() + AI_ACTION_TTL_MS),
      });
      await recordEvent({
        action,
        actorId: context.userId,
        type: AI_ACTION_EVENT.SUGGESTED,
        fromStatus: "",
        toStatus: AI_ACTION_STATUS.SUGGESTED,
        metadata: { schemaVersion: AI_ACTION_SCHEMA_VERSION },
      });
      records.push(action);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await AiActionModel.findOne({
        tenant: context.tenantId,
        idempotencyKey,
      });
      if (existing) {
        await recordEvent({
          action: existing,
          actorId: context.userId,
          type: AI_ACTION_EVENT.SUGGESTED,
          fromStatus: "",
          toStatus: AI_ACTION_STATUS.SUGGESTED,
          metadata: { schemaVersion: AI_ACTION_SCHEMA_VERSION },
        });
        records.push(existing);
      }
    }
  }
  return records;
};

const assertWorkspaceAudit = (
  access: ResolvedWorkspaceAccess,
  scope: AiActionListInput["scope"],
) => {
  if (
    scope === "workspace" &&
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.AI_AUDIT_VIEW)
  ) {
    forbidden({
      message: "AI audit permission is required.",
      code: "WORKSPACE_PERMISSION_REQUIRED",
      details: { requiredPermissions: [WORKSPACE_PERMISSION.AI_AUDIT_VIEW] },
    });
  }
};

const visibleActionFilter = ({
  context,
  access,
  scope,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  scope: "mine" | "workspace";
}) => {
  const actorId = requireActor(context);
  return {
    tenant: context.tenantId,
    ...(scope === "mine" ? { requestedBy: actorId } : {}),
    ...actionLocationFilter(access, actorId),
  };
};

export const listAiActions = async ({
  context,
  input,
}: {
  context: AiRequestContext;
  input: AiActionListInput;
}) => {
  const access = await freshAccess(context);
  assertWorkspaceAudit(access, input.scope);
  const conversationIds = await visibleActionConversationIds({
    context,
    access,
    scope: input.scope,
  });
  const baseFilter: Record<string, unknown> = {
    ...visibleActionFilter({
      context,
      access,
      scope: input.scope,
    }),
    conversation: { $in: conversationIds },
  };
  await expireSuggestedActions(baseFilter);
  const filter = {
    ...baseFilter,
    ...(input.status ? { status: input.status } : {}),
  };
  const skip = (input.page - 1) * input.limit;
  const [items, total, pendingCount] = await Promise.all([
    AiActionModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .lean(),
    AiActionModel.countDocuments(filter),
    AiActionModel.countDocuments({
      ...baseFilter,
      status: AI_ACTION_STATUS.SUGGESTED,
      expiresAt: { $gt: new Date() },
    }),
  ]);
  await Promise.all(items.map(ensureTerminalEvent));
  return {
    items: items.map((action) =>
      serializeAiAction(action, input.scope === "mine" ? context.userId : null),
    ),
    total,
    page: input.page,
    limit: input.limit,
    pages: Math.ceil(total / input.limit),
    pendingCount,
    scope: input.scope,
  };
};

export const getAiAction = async ({
  context,
  actionId,
  scope,
}: {
  context: AiRequestContext;
  actionId: string;
  scope: "mine" | "workspace";
}) => {
  const access = await freshAccess(context);
  assertWorkspaceAudit(access, scope);
  const filter = visibleActionFilter({ context, access, scope });
  const candidate = await AiActionModel.findOne({
    ...filter,
    _id: actionId,
  }).lean();
  if (!candidate) notFound("AI action not found.");
  const scopedFilter = {
    ...filter,
    _id: actionId,
    conversation: candidate.conversation,
  };
  await assertCurrentActionConversation({
    context,
    access,
    conversationId: String(candidate.conversation),
    scope,
  });
  await expireSuggestedActions(scopedFilter);
  const action = await AiActionModel.findOne(scopedFilter).lean();
  if (!action) notFound("AI action not found.");
  await ensureTerminalEvent(action);
  const events = await AiActionEventModel.find({
    tenant: context.tenantId,
    action: actionId,
  })
    .sort({ createdAt: 1 })
    .select("type fromStatus toStatus createdAt")
    .lean();
  return {
    action: serializeAiAction(action, scope === "mine" ? context.userId : null),
    events: events.map((event) => ({
      id: String(event._id),
      type: event.type,
      fromStatus: event.fromStatus || null,
      toStatus: event.toStatus || null,
      createdAt: event.createdAt,
    })),
  };
};

export const getVisibleConversationAiActions = async ({
  context,
  conversationId,
}: {
  context: AiRequestContext;
  conversationId: string;
}) => {
  const access = await freshAccess(context);
  await assertCurrentActionConversation({
    context,
    access,
    conversationId,
  });
  const filter = {
    ...visibleActionFilter({ context, access, scope: "mine" }),
    conversation: conversationId,
  };
  await expireSuggestedActions(filter);
  const actions = await AiActionModel.find(filter)
    .sort({ createdAt: -1 })
    .lean();
  await Promise.all(actions.map(ensureTerminalEvent));
  return actions;
};

const currentUserContext = (
  context: AiRequestContext,
  access: ResolvedWorkspaceAccess,
) => ({
  id: requireActor(context),
  tenantId: context.tenantId,
  allowedLocationIds:
    access.locationAccess.mode === "all"
      ? null
      : access.locationAccess.locationIds,
  defaultLocationId: access.preferences.defaultLocation || null,
});

const executeCreateTask = async ({
  context,
  access,
  action,
  payload,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  action: any;
  payload: any;
}) => {
  const input = createStaffTaskSchema.parse({
    title: payload.title,
    description: payload.description || "",
    locationId: payload.locationId || null,
    appliesToAllLocations: payload.appliesToAllLocations === true,
    assignedTo: null,
    dueDate: payload.dueDate || null,
    status: STAFF_TASK_STATUS.TODO,
    priority: payload.priority || "normal",
    category: "general",
    blockerReason: "",
  });
  let task: any;
  try {
    task = await staffTaskService.create(
      currentUserContext(context, access),
      input,
      { source: "ai", aiActionId: String(action._id) },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    task = await StaffTaskModel.findOne({
      tenantId: context.tenantId,
      aiActionId: action._id,
    } as never).lean();
    if (!task) throw error;
  }
  return {
    type: "staff_task",
    id: String(task._id),
    title: String(task.title || payload.title),
  };
};

const assertTaskTarget = (
  context: AiRequestContext,
  access: ResolvedWorkspaceAccess,
  task: any,
) => {
  if (!task) notFound("Staff task not found.");
  if (task.locationId) {
    if (!canAccessWorkspaceLocation(access, String(task.locationId))) {
      notFound("Staff task not found.");
    }
    return;
  }
  if (
    access.locationAccess.mode !== "all" &&
    String(task.assignedTo || "") !== String(context.userId)
  ) {
    notFound("Staff task not found.");
  }
};

const executeCompleteTask = async ({
  context,
  access,
  payload,
  targetSnapshot,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  payload: any;
  targetSnapshot: any;
}) => {
  const current = await StaffTaskModel.findOne({
    _id: payload.taskId,
    tenantId: context.tenantId,
  } as never)
    .select(
      "title status locationId appliesToAllLocations assignedTo updatedAt",
    )
    .lean();
  assertTaskTarget(context, access, current);
  if (current.status === STAFF_TASK_STATUS.DONE) {
    return {
      type: "staff_task",
      id: String(current._id),
      title: String(current.title || ""),
    };
  }
  if (
    String(current.status) !== String(targetSnapshot?.status || "") ||
    new Date(current.updatedAt).toISOString() !==
      new Date(targetSnapshot?.updatedAt).toISOString()
  ) {
    conflict({
      message: "The task changed after this action was proposed.",
      code: "AI_ACTION_TARGET_CHANGED",
    });
  }
  const task = await staffTaskService.update(
    currentUserContext(context, access),
    payload.taskId,
    { status: STAFF_TASK_STATUS.DONE },
    {
      expectedSnapshot: {
        status: String(targetSnapshot.status),
        updatedAt: String(targetSnapshot.updatedAt),
      },
    },
  );
  return {
    type: "staff_task",
    id: String(task._id),
    title: String(task.title || current.title || ""),
  };
};

const executeCreateReorder = async ({
  context,
  access,
  action,
  payload,
  targetSnapshot,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  action: any;
  payload: any;
  targetSnapshot: any;
}) => {
  if (!canAccessWorkspaceLocation(access, payload.locationId)) {
    notFound("Inventory item not found.");
  }
  const findExistingRequest = () =>
    ReorderRequest.findOne({
      tenant: context.tenantId,
      aiActionId: action._id,
      item: payload.itemId,
      location: payload.locationId,
    }).lean();
  const existingRequest = await findExistingRequest();
  if (existingRequest) {
    return {
      type: "inventory_reorder_request",
      id: String(existingRequest._id),
      itemName: String(
        action.preview?.target?.label || action.preview?.title || "",
      ),
    };
  }
  const item = await InventoryItem.findOne({
    _id: payload.itemId,
    tenant: context.tenantId,
    isActive: true,
  })
    .select("name unit stockLevels updatedAt")
    .lean();
  if (!item) notFound("Inventory item not found.");
  const level = (item.stockLevels || []).find(
    (entry: any) => String(entry.location) === String(payload.locationId),
  );
  if (!level) notFound("Inventory item not found.");
  const currentQuantity = Number(level.currentQuantity || 0);
  const minimumQuantity = Number(level.minimumQuantity || 0);
  if (
    new Date(item.updatedAt).getTime() !==
      new Date(targetSnapshot?.updatedAt).getTime() ||
    currentQuantity !== Number(targetSnapshot?.currentQuantity) ||
    minimumQuantity !== Number(targetSnapshot?.minimumQuantity)
  ) {
    conflict({
      message: "Inventory levels changed after this action was proposed.",
      code: "AI_ACTION_TARGET_CHANGED",
    });
  }
  if (minimumQuantity <= 0 || currentQuantity > minimumQuantity) {
    conflict({
      message: "This inventory item is no longer low on stock.",
      code: "AI_ACTION_TARGET_CHANGED",
    });
  }
  const input = createReorderRequestSchema.parse({
    item: payload.itemId,
    location: payload.locationId,
    requestedQuantity: payload.requestedQuantity,
    priority: payload.priority,
    note: payload.note || "",
  });
  let request: any;
  try {
    request = await inventoryService.createReorderRequest(
      context.tenantId,
      requireActor(context),
      input,
      access.locationAccess.mode === "all"
        ? null
        : access.locationAccess.locationIds,
      {
        source: "ai",
        aiActionId: String(action._id),
        expectedSnapshot: {
          updatedAt: String(targetSnapshot.updatedAt),
          currentQuantity: Number(targetSnapshot.currentQuantity),
          minimumQuantity: Number(targetSnapshot.minimumQuantity),
        },
      },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    request = await findExistingRequest();
    if (!request) throw error;
  }
  return {
    type: "inventory_reorder_request",
    id: String(request._id),
    itemName: String(item.name || ""),
  };
};

const executeCreateEvent = async ({
  context,
  access,
  action,
  payload,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  action: any;
  payload: any;
}) => {
  if (
    String(action.locationId || "") !== String(payload.locationId || "") ||
    !canAccessWorkspaceLocation(access, String(payload.locationId || ""))
  ) {
    notFound("AI action not found.");
  }
  const location = await LocationModel.findOne({
    _id: payload.locationId,
    tenant: context.tenantId,
    isActive: true,
  })
    .select("booking.timezone")
    .lean();
  if (!location) notFound("AI action not found.");
  const timeZone = String((location as any)?.booking?.timezone || "");
  const findExistingEvent = () =>
    eventRepository.findByAiActionIdForTenant(
      context.tenantId,
      String(action._id),
    );
  let event: any;
  try {
    event = await findExistingEvent();
  } catch {
    throw new RecoverableAiActionExecutionError(
      "The existing event could not be verified.",
    );
  }
  if (event) {
    return {
      type: "event",
      id: String(event._id),
      title: String(event.title || payload.title),
    };
  }
  if (
    !isFutureCalendarDateInTimeZone({
      date: payload.date,
      timeZone,
    })
  ) {
    conflict({
      message: "The event date is no longer in the future.",
      code: "AI_ACTION_TARGET_CHANGED",
    });
  }

  const input = createEventSchema.parse({
    title: payload.title,
    type: EVENT_TYPE.OTHER,
    status: EVENT_STATUS.INQUIRY,
    location: payload.locationId,
    date: payload.date,
    startTime: payload.startTime,
    endTime: payload.endTime,
    order: null,
  });
  try {
    event = await eventService.create(
      context.tenantId,
      requireActor(context),
      input,
      { aiActionId: String(action._id) },
    );
  } catch (error) {
    try {
      event = await findExistingEvent();
    } catch {
      throw new RecoverableAiActionExecutionError(
        "The event creation outcome could not be verified.",
      );
    }
    if (!event) throw error;
  }
  return {
    type: "event",
    id: String(event._id),
    title: String(event.title || payload.title),
  };
};

const executeAction = async ({
  context,
  access,
  action,
}: {
  context: AiRequestContext;
  access: ResolvedWorkspaceAccess;
  action: any;
}) => {
  const definition = getAiActionDefinition(action.key);
  if (!definition) {
    forbidden({
      message: "This AI action is not supported.",
      code: "AI_ACTION_UNSUPPORTED",
    });
  }
  const parsed = definition.payloadSchema.safeParse(action.payload);
  if (!parsed.success) {
    conflict({
      message: "This AI action is no longer compatible.",
      code: "AI_ACTION_VERSION_UNSUPPORTED",
    });
  }
  if (action.key === AI_ACTION_KEY.CREATE_TASK) {
    return executeCreateTask({
      context,
      access,
      action,
      payload: parsed.data,
    });
  }
  if (action.key === AI_ACTION_KEY.COMPLETE_TASK) {
    return executeCompleteTask({
      context,
      access,
      payload: parsed.data,
      targetSnapshot: action.targetSnapshot,
    });
  }
  if (action.key === AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST) {
    return executeCreateReorder({
      context,
      access,
      action,
      payload: parsed.data,
      targetSnapshot: action.targetSnapshot,
    });
  }
  if (action.key === AI_ACTION_KEY.CREATE_EVENT) {
    return executeCreateEvent({
      context,
      access,
      action,
      payload: parsed.data,
    });
  }
  forbidden({
    message: "This AI action is not supported.",
    code: "AI_ACTION_UNSUPPORTED",
  });
};

export const confirmAiAction = async ({
  context,
  actionId,
  conversationId,
}: {
  context: AiRequestContext;
  actionId: string;
  conversationId?: string;
}) => {
  const actorId = requireActor(context);
  const access = await freshAccess(context);
  let action = await AiActionModel.findOne({
    _id: actionId,
    tenant: context.tenantId,
    requestedBy: actorId,
    ...(conversationId ? { conversation: conversationId } : {}),
  }).select("+payload +targetSnapshot +error");
  if (!action) notFound("AI action not found.");
  await assertCurrentActionConversation({
    context,
    access,
    conversationId: String(action.conversation),
  });
  await assertDefinitionAccess({ context, access, action });
  if (action.status === AI_ACTION_STATUS.COMPLETED) {
    await ensureTerminalEvent(action);
    return {
      action: serializeAiAction(action, actorId),
      idempotent: true,
    };
  }
  if (
    action.status === AI_ACTION_STATUS.SUGGESTED &&
    action.expiresAt.getTime() <= Date.now()
  ) {
    const expiryNow = new Date();
    const expired = await AiActionModel.findOneAndUpdate(
      {
        _id: action._id,
        tenant: context.tenantId,
        requestedBy: actorId,
        status: AI_ACTION_STATUS.SUGGESTED,
        expiresAt: { $lte: expiryNow },
        executionVersion: action.executionVersion,
      },
      {
        $set: {
          status: AI_ACTION_STATUS.EXPIRED,
          decidedAt: expiryNow,
        },
      },
      { returnDocument: "after" },
    ).select("+payload +targetSnapshot +error");
    if (expired) {
      await recordEvent({
        action: expired,
        actorId,
        type: AI_ACTION_EVENT.EXPIRED,
        fromStatus: AI_ACTION_STATUS.SUGGESTED,
        toStatus: AI_ACTION_STATUS.EXPIRED,
      });
      conflict({
        message: "This AI action has expired.",
        code: "AI_ACTION_EXPIRED",
      });
    }
    action = await AiActionModel.findOne({
      _id: action._id,
      tenant: context.tenantId,
      requestedBy: actorId,
      ...(conversationId ? { conversation: conversationId } : {}),
    }).select("+payload +targetSnapshot +error");
    if (!action) notFound("AI action not found.");
    if (action.status === AI_ACTION_STATUS.COMPLETED) {
      await ensureTerminalEvent(action);
      return {
        action: serializeAiAction(action, actorId),
        idempotent: true,
      };
    }
  }
  const recovering =
    action.status === AI_ACTION_STATUS.EXECUTING &&
    action.leaseExpiresAt &&
    action.leaseExpiresAt.getTime() <= Date.now();
  if (action.status !== AI_ACTION_STATUS.SUGGESTED && !recovering) {
    conflict({
      message:
        action.status === AI_ACTION_STATUS.EXECUTING
          ? "This AI action is already being processed."
          : "This AI action has already been decided.",
      code:
        action.status === AI_ACTION_STATUS.EXECUTING
          ? "AI_ACTION_IN_PROGRESS"
          : "AI_ACTION_ALREADY_DECIDED",
      details: { status: action.status },
    });
  }
  if (
    action.schemaVersion !== AI_ACTION_SCHEMA_VERSION ||
    !action.payloadHash ||
    payloadHash(action.payload) !== action.payloadHash
  ) {
    conflict({
      message: "This AI action is no longer compatible.",
      code: "AI_ACTION_VERSION_UNSUPPORTED",
    });
  }
  const now = new Date();
  const previousStatus = action.status;
  const claimFilter: Record<string, unknown> = {
    _id: action._id,
    tenant: context.tenantId,
    requestedBy: actorId,
    payloadHash: action.payloadHash,
    executionVersion: action.executionVersion,
    ...(recovering
      ? {
          status: AI_ACTION_STATUS.EXECUTING,
          leaseExpiresAt: { $lte: now },
        }
      : {
          status: AI_ACTION_STATUS.SUGGESTED,
          expiresAt: { $gt: now },
        }),
  };
  const claimed = await AiActionModel.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        status: AI_ACTION_STATUS.EXECUTING,
        decidedAt: action.decidedAt || now,
        leaseExpiresAt: new Date(now.getTime() + AI_ACTION_EXECUTION_LEASE_MS),
        errorCode: "",
        error: "",
      },
      $inc: { executionAttempts: 1, executionVersion: 1 },
    },
    { returnDocument: "after" },
  ).select("+payload +targetSnapshot +error");
  if (!claimed) {
    conflict({
      message: "This AI action is already being processed.",
      code: "AI_ACTION_IN_PROGRESS",
    });
  }
  await recordEvent({
    action: claimed,
    actorId,
    type: recovering ? AI_ACTION_EVENT.RECOVERED : AI_ACTION_EVENT.CONFIRMED,
    fromStatus: previousStatus,
    toStatus: AI_ACTION_STATUS.EXECUTING,
    metadata: { attempt: claimed.executionAttempts },
  });

  let result: unknown;
  try {
    result = await executeAction({ context, access, action: claimed });
  } catch (error) {
    if (error instanceof RecoverableAiActionExecutionError) throw error;
    const code = errorCode(error);
    const failed = await AiActionModel.findOneAndUpdate(
      {
        _id: claimed._id,
        tenant: context.tenantId,
        status: AI_ACTION_STATUS.EXECUTING,
        executionVersion: claimed.executionVersion,
      },
      {
        $set: {
          status: AI_ACTION_STATUS.FAILED,
          leaseExpiresAt: null,
          errorCode: code,
          error:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Action failed.",
        },
      },
      { returnDocument: "after" },
    );
    if (failed) {
      await recordEvent({
        action: failed,
        actorId,
        type: AI_ACTION_EVENT.FAILED,
        fromStatus: AI_ACTION_STATUS.EXECUTING,
        toStatus: AI_ACTION_STATUS.FAILED,
        metadata: { errorCode: code },
      });
    }
    throw error;
  }

  const completed = await AiActionModel.findOneAndUpdate(
    {
      _id: claimed._id,
      tenant: context.tenantId,
      status: AI_ACTION_STATUS.EXECUTING,
      executionVersion: claimed.executionVersion,
    },
    {
      $set: {
        status: AI_ACTION_STATUS.COMPLETED,
        result,
        completedAt: new Date(),
        leaseExpiresAt: null,
        errorCode: "",
        error: "",
      },
    },
    { returnDocument: "after" },
  );
  if (!completed) {
    conflict({
      message: "This AI action was superseded by another worker.",
      code: "AI_ACTION_IN_PROGRESS",
    });
  }
  await recordEvent({
    action: completed,
    actorId,
    type: AI_ACTION_EVENT.COMPLETED,
    fromStatus: AI_ACTION_STATUS.EXECUTING,
    toStatus: AI_ACTION_STATUS.COMPLETED,
  });
  return {
    action: serializeAiAction(completed, actorId),
    idempotent: recovering,
  };

};

export const dismissAiAction = async ({
  context,
  actionId,
  conversationId,
}: {
  context: AiRequestContext;
  actionId: string;
  conversationId?: string;
}) => {
  const actorId = requireActor(context);
  const access = await freshAccess(context);
  const action = await AiActionModel.findOne({
    _id: actionId,
    tenant: context.tenantId,
    requestedBy: actorId,
    ...(conversationId ? { conversation: conversationId } : {}),
  });
  if (!action) notFound("AI action not found.");
  await assertCurrentActionConversation({
    context,
    access,
    conversationId: String(action.conversation),
  });
  if (action.status === AI_ACTION_STATUS.DISMISSED) {
    await ensureTerminalEvent(action);
    return { action: serializeAiAction(action, actorId), idempotent: true };
  }
  if (action.status !== AI_ACTION_STATUS.SUGGESTED) {
    conflict({
      message: "This AI action has already been decided.",
      code: "AI_ACTION_ALREADY_DECIDED",
      details: { status: action.status },
    });
  }
  const now = new Date();
  if (action.expiresAt.getTime() <= now.getTime()) {
    const expired = await AiActionModel.findOneAndUpdate(
      {
        _id: action._id,
        tenant: context.tenantId,
        requestedBy: actorId,
        status: AI_ACTION_STATUS.SUGGESTED,
      },
      {
        $set: {
          status: AI_ACTION_STATUS.EXPIRED,
          decidedAt: now,
        },
      },
      { returnDocument: "after" },
    );
    if (!expired) {
      conflict({
        message: "This AI action has already been decided.",
        code: "AI_ACTION_ALREADY_DECIDED",
      });
    }
    await recordEvent({
      action: expired,
      actorId,
      type: AI_ACTION_EVENT.EXPIRED,
      fromStatus: AI_ACTION_STATUS.SUGGESTED,
      toStatus: AI_ACTION_STATUS.EXPIRED,
    });
    return { action: serializeAiAction(expired, actorId), idempotent: false };
  }
  const dismissed = await AiActionModel.findOneAndUpdate(
    {
      _id: action._id,
      tenant: context.tenantId,
      requestedBy: actorId,
      status: AI_ACTION_STATUS.SUGGESTED,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        status: AI_ACTION_STATUS.DISMISSED,
        decidedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!dismissed) {
    conflict({
      message: "This AI action has already been decided.",
      code: "AI_ACTION_ALREADY_DECIDED",
    });
  }
  await recordEvent({
    action: dismissed,
    actorId,
    type: AI_ACTION_EVENT.DISMISSED,
    fromStatus: AI_ACTION_STATUS.SUGGESTED,
    toStatus: AI_ACTION_STATUS.DISMISSED,
  });
  return { action: serializeAiAction(dismissed, actorId), idempotent: false };
};

export const aiActionService = {
  persistSuggested: persistSuggestedActions,
  list: listAiActions,
  get: getAiAction,
  getVisibleConversationActions: getVisibleConversationAiActions,
  confirm: confirmAiAction,
  dismiss: dismissAiAction,
};
