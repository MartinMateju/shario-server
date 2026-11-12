// services/staff-task.service.ts

import { startSession } from "mongoose";

import { conflict, notFound } from "../../../shared/http/httpErrors.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
} from "@/modules/tenant-access/index.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
} from "@/modules/tenant-access/tenant-access.constants.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { emitWorkspaceNotificationEvent } from "@/modules/workspace-notifications/workspace-notification.events.js";

import { createStaffRepository } from "../staff.repository.js";
import { assertStaffTasksModuleEnabled } from "../staff-entitlement.service.js";
import { unlinkStaffTaskFromPlanning } from "../staff-planning-links.service.js";
import {
  assertValidStaffTaskLinks,
  filterVisibleStaffTaskLinks,
} from "../staff-task-links.service.js";
import type { CurrentUserContext } from "../staff.types.js";
import type {
  CreateStaffTaskInput,
  ListStaffTasksInput,
  UpdateStaffTaskInput,
} from "../staff.validators.js";

const inputLocation = (
  input: CreateStaffTaskInput | UpdateStaffTaskInput,
): string | null | undefined =>
  input.locationId !== undefined ? input.locationId : input.location;

const isAssignedStatusOnlyPatch = (
  input: UpdateStaffTaskInput,
  assignedTo: unknown,
  actorId: unknown,
) => {
  const allowedKeys = new Set(["status", "blockerReason"]);
  const keys = Object.keys(input).filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  );
  return (
    String(assignedTo || "") === String(actorId || "") &&
    keys.length > 0 &&
    keys.every((key) => allowedKeys.has(key))
  );
};

const taskScope = (task: {
  appliesToAllLocations?: boolean;
  locationId?: unknown;
}) => {
  const locationId = task.locationId ? String(task.locationId) : null;
  return {
    global: task.appliesToAllLocations === true || !locationId,
    locationId,
  };
};

const effectiveTaskScope = (
  existing: { appliesToAllLocations?: boolean; locationId?: unknown },
  input: UpdateStaffTaskInput,
) => {
  const requestedLocationId = inputLocation(input);
  const hasLocationPatch =
    Object.prototype.hasOwnProperty.call(input, "location") ||
    Object.prototype.hasOwnProperty.call(input, "locationId");
  const locationId =
    input.appliesToAllLocations === true
      ? null
      : hasLocationPatch
        ? requestedLocationId || null
        : existing.locationId
          ? String(existing.locationId)
          : null;
  const appliesToAllLocations =
    input.appliesToAllLocations === true
      ? true
      : locationId
        ? false
        : (input.appliesToAllLocations ??
          existing.appliesToAllLocations ??
          false);
  return taskScope({ appliesToAllLocations, locationId });
};

const taskScopesDiffer = (
  left: ReturnType<typeof taskScope>,
  right: ReturnType<typeof taskScope>,
) =>
  left.global !== right.global ||
  (!left.global && left.locationId !== right.locationId);

const taskLocationId = (task: any) =>
  task?.locationId ? String(task.locationId?._id ?? task.locationId) : null;

const emitTaskAssignmentNotification = ({
  tenantId,
  actorId,
  task,
}: {
  tenantId: string;
  actorId: string;
  task: any;
}): void => {
  const assignedTo = String(task?.assignedTo?._id ?? task?.assignedTo ?? "");
  if (!assignedTo || assignedTo === actorId) return;

  const taskId = String(task?._id ?? "");
  const title = String(task?.title || "Task");
  const assignmentVersion = String(
    task?.updatedAt ?? task?.createdAt ?? taskId,
  );
  const locationId =
    task?.appliesToAllLocations === true ? null : taskLocationId(task);

  emitWorkspaceNotificationEvent({
    tenantId,
    recipientUserIds: [assignedTo],
    requiredPermission: WORKSPACE_PERMISSION.TASKS_VIEW,
    preferenceKey: "taskAssigned",
    ...(locationId ? { locationId } : {}),
    eventType: "task.assigned",
    severity: "info",
    title: {
      en: "Task assigned",
      cs: "Přiřazen nový úkol",
    },
    message: {
      en: `You were assigned “${title}”.`,
      cs: `Byl vám přiřazen úkol „${title}“.`,
    },
    actionUrl: "/app/operations?section=tasks",
    sourceType: "staff-task",
    sourceId: taskId,
    deduplicationKey: `staff-task:${taskId}:assigned:${assignedTo}:${assignmentVersion}`,
    groupKey: "task.assigned",
  });
};

const serializeTaskForReader = async (
  context: CurrentUserContext,
  task: any,
) => {
  const value = typeof task?.toObject === "function" ? task.toObject() : task;
  const {
    communicationConversationId: _internalConversationId,
    aiActionId: _internalAiActionId,
    ...publicValue
  } = value || {};
  return {
    ...publicValue,
    links: await filterVisibleStaffTaskLinks({
      tenantId: String(context.tenantId),
      allowedLocationIds: context.allowedLocationIds ?? null,
      taskLocationId: taskLocationId(publicValue),
      links: publicValue?.links || [],
    }),
  };
};

const assertActiveAssignee = async ({
  tenantId,
  assignedTo,
  taskLocationId,
  requiresAllLocations = false,
}: {
  tenantId: string;
  assignedTo: string;
  taskLocationId?: string | null;
  requiresAllLocations?: boolean;
}) => {
  const membership: any = await TenantMembershipModel.findOne({
    tenant: tenantId,
    user: assignedTo,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  })
    .select("locationAccess")
    .lean();
  if (!membership) notFound("Assigned workspace member not found.");
  if (
    requiresAllLocations &&
    membership.locationAccess?.mode === LOCATION_ACCESS_MODE.SELECTED
  ) {
    notFound("Assigned workspace member not found.");
  }
  if (
    taskLocationId &&
    membership.locationAccess?.mode === LOCATION_ACCESS_MODE.SELECTED &&
    !(membership.locationAccess.locationIds || [])
      .map(String)
      .includes(String(taskLocationId))
  ) {
    notFound("Assigned workspace member not found.");
  }
};

export const staffTaskService = {
  async list(context: CurrentUserContext, input: ListStaffTasksInput) {
    await assertStaffTasksModuleEnabled(String(context.tenantId));
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });

    const allowedLocationIds = context.allowedLocationIds ?? null;
    if (allowedLocationIds !== null && allowedLocationIds.length === 0) {
      return {
        tasks: [],
        total: 0,
        page: input.page,
        limit: input.limit,
        pages: 0,
      };
    }

    if (input.location) {
      await assertTenantLocationsWithinWorkspaceScope({
        tenantId: String(context.tenantId),
        locationIds: [input.location],
        allowedLocationIds,
      });
    }

    const result = await staffRepository.listTasks({
      ...input,
      locationId: input.location,
      allowedLocationIds,
    });
    return {
      ...result,
      tasks: await Promise.all(
        (result.tasks || []).map((task: any) =>
          serializeTaskForReader(context, task),
        ),
      ),
    };
  },

  async create(
    context: CurrentUserContext,
    input: CreateStaffTaskInput,
    metadata: {
      source?: "manual" | "communication" | "ai";
      communicationConversationId?: string | null;
      aiActionId?: string | null;
    } = {},
  ) {
    await assertStaffTasksModuleEnabled(String(context.tenantId));
    if (context.allowedLocationIds?.length === 0) {
      notFound("Staff task not found.");
    }
    const staffRepository = createStaffRepository({
      tenantId: context.tenantId,
    });
    const allowed = context.allowedLocationIds ?? null;
    const preferred = context.defaultLocationId;
    const fallbackLocation =
      preferred && (allowed === null || allowed.includes(preferred))
        ? preferred
        : allowed !== null && allowed.length
          ? [...allowed].map(String).sort()[0]
          : null;
    const locationId =
      inputLocation(input) ||
      (input.appliesToAllLocations ? null : fallbackLocation);
    const normalizedInput: CreateStaffTaskInput = {
      ...input,
      locationId,
      appliesToAllLocations: !locationId,
    };

    if (normalizedInput.appliesToAllLocations) {
      assertCanAccessAllWorkspaceLocations(context.allowedLocationIds ?? null);
    } else if (locationId) {
      await assertTenantLocationsWithinWorkspaceScope({
        tenantId: String(context.tenantId),
        locationIds: [locationId],
        allowedLocationIds: context.allowedLocationIds ?? null,
      });
    } else {
      assertCanAccessAllWorkspaceLocations(context.allowedLocationIds ?? null);
    }

    if (normalizedInput.assignedTo) {
      await assertActiveAssignee({
        tenantId: String(context.tenantId),
        assignedTo: normalizedInput.assignedTo,
        taskLocationId: normalizedInput.appliesToAllLocations
          ? null
          : locationId,
        requiresAllLocations: normalizedInput.appliesToAllLocations,
      });
    }
    if (normalizedInput.links?.length) {
      await assertValidStaffTaskLinks({
        tenantId: String(context.tenantId),
        allowedLocationIds: context.allowedLocationIds ?? null,
        taskLocationId: normalizedInput.appliesToAllLocations
          ? null
          : locationId,
        links: normalizedInput.links,
      });
    }

    const task = await staffRepository.createTask(
      context.id,
      normalizedInput,
      metadata,
    );
    emitTaskAssignmentNotification({
      tenantId: String(context.tenantId),
      actorId: String(context.id),
      task,
    });
    return serializeTaskForReader(context, task);
  },

  async update(
    context: CurrentUserContext,
    id: string,
    input: UpdateStaffTaskInput,
    options: {
      expectedSnapshot?: { status: string; updatedAt: string };
    } = {},
  ) {
    await assertStaffTasksModuleEnabled(String(context.tenantId));
    if (context.allowedLocationIds?.length === 0) {
      notFound("Staff task not found.");
    }
    const requestedLocationId = inputLocation(input);
    const hasLocationPatch =
      Object.prototype.hasOwnProperty.call(input, "location") ||
      Object.prototype.hasOwnProperty.call(input, "locationId");
    const session = await startSession();
    let task: any = null;
    let previousAssignedTo: string | null = null;
    try {
      await session.withTransaction(async () => {
        const transactionRepository = createStaffRepository({
          tenantId: context.tenantId,
          session,
        });
        const current = await transactionRepository.findTaskById(id);
        if (!current) notFound("Staff task not found.");
        previousAssignedTo = current.assignedTo
          ? String(current.assignedTo?._id ?? current.assignedTo)
          : null;

        if (current.appliesToAllLocations || !current.locationId) {
          if (
            context.allowedLocationIds !== null &&
            context.allowedLocationIds !== undefined &&
            !isAssignedStatusOnlyPatch(input, current.assignedTo, context.id)
          ) {
            assertCanAccessAllWorkspaceLocations(
              context.allowedLocationIds ?? null,
            );
          }
        } else {
          assertLocationIdsWithinWorkspaceScope(
            [current.locationId],
            context.allowedLocationIds ?? null,
          );
        }

        if (options.expectedSnapshot) {
          const currentUpdatedAt = new Date(current.updatedAt).getTime();
          const expectedUpdatedAt = new Date(
            options.expectedSnapshot.updatedAt,
          ).getTime();
          if (
            String(current.status) !== options.expectedSnapshot.status ||
            !Number.isFinite(currentUpdatedAt) ||
            !Number.isFinite(expectedUpdatedAt) ||
            currentUpdatedAt !== expectedUpdatedAt
          ) {
            conflict({
              message: "The task changed after this action was proposed.",
              code: "AI_ACTION_TARGET_CHANGED",
            });
          }
        }

        if (input.appliesToAllLocations === true) {
          assertCanAccessAllWorkspaceLocations(
            context.allowedLocationIds ?? null,
          );
        } else if (requestedLocationId) {
          await assertTenantLocationsWithinWorkspaceScope({
            tenantId: String(context.tenantId),
            locationIds: [requestedLocationId],
            allowedLocationIds: context.allowedLocationIds ?? null,
          });
        } else if (hasLocationPatch) {
          assertCanAccessAllWorkspaceLocations(
            context.allowedLocationIds ?? null,
          );
        }

        const nextScope = effectiveTaskScope(current, input);
        const effectiveAssignedTo =
          input.assignedTo !== undefined
            ? input.assignedTo
            : current.assignedTo
              ? String(current.assignedTo)
              : null;
        const scopeRequested =
          input.appliesToAllLocations !== undefined || hasLocationPatch;
        if (
          effectiveAssignedTo &&
          (input.assignedTo !== undefined || scopeRequested)
        ) {
          await assertActiveAssignee({
            tenantId: String(context.tenantId),
            assignedTo: String(effectiveAssignedTo),
            taskLocationId: nextScope.global ? null : nextScope.locationId,
            requiresAllLocations: nextScope.global,
          });
        }
        const effectiveLinks =
          input.links !== undefined ? input.links : current.links || [];
        if (
          input.links !== undefined ||
          taskScopesDiffer(taskScope(current), nextScope)
        ) {
          await assertValidStaffTaskLinks({
            tenantId: String(context.tenantId),
            allowedLocationIds: context.allowedLocationIds ?? null,
            taskLocationId: nextScope.global ? null : nextScope.locationId,
            links: effectiveLinks,
          });
        }

        if (taskScopesDiffer(taskScope(current), nextScope)) {
          await unlinkStaffTaskFromPlanning({
            tenantId: String(context.tenantId),
            taskId: id,
            session,
          });
        }
        task = await transactionRepository.updateTaskById(id, input);
        if (!task) notFound("Staff task not found.");
      });
    } finally {
      await session.endSession();
    }

    const nextAssignedTo = task?.assignedTo
      ? String(task.assignedTo?._id ?? task.assignedTo)
      : null;
    if (
      input.assignedTo !== undefined &&
      nextAssignedTo &&
      nextAssignedTo !== previousAssignedTo
    ) {
      emitTaskAssignmentNotification({
        tenantId: String(context.tenantId),
        actorId: String(context.id),
        task,
      });
    }

    return serializeTaskForReader(context, task);
  },

  async delete(context: CurrentUserContext, id: string) {
    await assertStaffTasksModuleEnabled(String(context.tenantId));
    if (context.allowedLocationIds?.length === 0) {
      notFound("Staff task not found.");
    }
    const session = await startSession();
    try {
      await session.withTransaction(async () => {
        const staffRepository = createStaffRepository({
          tenantId: context.tenantId,
          session,
        });
        // Re-read inside the transaction so authorization, unlinking and
        // deletion all apply to the same scoped task state.
        const existing = await staffRepository.findTaskById(id);
        if (!existing) notFound("Staff task not found.");

        if (existing.appliesToAllLocations || !existing.locationId) {
          assertCanAccessAllWorkspaceLocations(
            context.allowedLocationIds ?? null,
          );
        } else {
          assertLocationIdsWithinWorkspaceScope(
            [existing.locationId],
            context.allowedLocationIds ?? null,
          );
        }

        await unlinkStaffTaskFromPlanning({
          tenantId: String(context.tenantId),
          taskId: id,
          session,
        });
        const result = await staffRepository.deleteTaskById(id);
        if (!result.deletedCount) notFound("Staff task not found.");
      });
    } finally {
      await session.endSession();
    }

    return { message: "Staff task deleted." };
  },
};
