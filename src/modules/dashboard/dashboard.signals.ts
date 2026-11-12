import mongoose from "mongoose";

import { buildConversationVisibilityFilter } from "@/modules/communications/communication.access.js";
import { CommunicationConversationModel } from "@/modules/communications/communications.models.js";
import {
  STAFF_TASK_PRIORITY,
  STAFF_TASK_STATUS,
} from "@/modules/staff/staff.constants.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import {
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
} from "@/modules/tenant-access/index.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import type { DashboardContext } from "./dashboard.types.js";

const SIGNAL_LIMIT = 3;

export type DashboardSignalUnavailableReason =
  "module_disabled" | "permission_required" | "source_temporarily_unavailable";

export type DashboardMessageSignalItem = {
  id: string;
  subject: string;
  contactName: string;
  preview: string;
  lastMessageAt: string | null;
  unreadCount: number;
};

export type DashboardTaskSignalItem = {
  id: string;
  title: string;
  assigneeName: string | null;
  priority: string;
  dueDate: string | null;
};

export type DashboardMessageSignals =
  | {
      available: true;
      reason: null;
      unreadCount: number;
      items: DashboardMessageSignalItem[];
    }
  | {
      available: false;
      reason: DashboardSignalUnavailableReason;
      unreadCount: null;
      items: null;
    };

export type DashboardTaskSignals =
  | {
      available: true;
      reason: null;
      openCount: number;
      items: DashboardTaskSignalItem[];
    }
  | {
      available: false;
      reason: DashboardSignalUnavailableReason;
      openCount: null;
      items: null;
    };

export type DashboardSignals = {
  messages: DashboardMessageSignals;
  tasks: DashboardTaskSignals;
};

export type DashboardSignalsInput = {
  context: DashboardContext;
  modules?: Readonly<Record<string, unknown>> | null;
  /**
   * The location ids after workspace-access and requested-location resolution.
   * Callers must not pass raw client-provided ids here.
   */
  locationIds: readonly string[];
};

const openTaskStatuses = [
  STAFF_TASK_STATUS.TODO,
  STAFF_TASK_STATUS.IN_PROGRESS,
  STAFF_TASK_STATUS.WAITING,
  STAFF_TASK_STATUS.BLOCKED,
] as const;

const unavailableMessages = (
  reason: DashboardSignalUnavailableReason,
): DashboardMessageSignals => ({
  available: false,
  reason,
  unreadCount: null,
  items: null,
});

const unavailableTasks = (
  reason: DashboardSignalUnavailableReason,
): DashboardTaskSignals => ({
  available: false,
  reason,
  openCount: null,
  items: null,
});

const nonNegativeInteger = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(Math.trunc(number), 0) : 0;
};

const safeText = (value: unknown, maximumLength: number): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);

const entityId = (value: unknown): string =>
  String(
    value && typeof value === "object" && "_id" in value
      ? (value as { _id?: unknown })._id
      : (value ?? ""),
  ).trim();

const optionalIsoDate = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

const assigneeDisplayName = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;

  const assignee = value as {
    displayName?: unknown;
    firstname?: unknown;
    lastname?: unknown;
    email?: unknown;
  };
  const workspaceName = safeText(assignee.displayName, 180);
  if (workspaceName) return workspaceName;

  const fullName = [
    safeText(assignee.firstname, 90),
    safeText(assignee.lastname, 90),
  ]
    .filter(Boolean)
    .join(" ");

  return fullName || safeText(assignee.email, 254) || null;
};

const loadMessageSignals = async ({
  context,
  modules,
  locationIds,
}: DashboardSignalsInput): Promise<DashboardMessageSignals> => {
  if (modules?.[TENANT_MODULE.COMMUNICATIONS] !== true) {
    return unavailableMessages("module_disabled");
  }
  if (
    !hasWorkspacePermission(
      context.access,
      WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
    )
  ) {
    return unavailableMessages("permission_required");
  }

  try {
    const visibility = buildConversationVisibilityFilter({
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.access.role,
      allowedLocationIds: locationIds,
      view: "all",
      includeRestricted: true,
    });

    const [rows, unreadCount] = await Promise.all([
      CommunicationConversationModel.find(visibility)
        .sort({ lastMessageAt: -1, _id: -1 })
        .limit(SIGNAL_LIMIT)
        .select(
          "_id subject contact.name lastMessagePreview lastMessageAt unreadCount",
        )
        .lean(),
      CommunicationConversationModel.countDocuments({
        $and: [visibility, { unreadCount: { $gt: 0 } }],
      }),
    ]);

    return {
      available: true,
      reason: null,
      unreadCount: nonNegativeInteger(unreadCount),
      items: (Array.isArray(rows) ? rows : [])
        .slice(0, SIGNAL_LIMIT)
        .map((conversation: any) => ({
          id: entityId(conversation?._id),
          subject: safeText(conversation?.subject, 300),
          contactName: safeText(conversation?.contact?.name, 180),
          preview: safeText(conversation?.lastMessagePreview, 300),
          lastMessageAt: optionalIsoDate(conversation?.lastMessageAt),
          unreadCount: nonNegativeInteger(conversation?.unreadCount),
        })),
    };
  } catch {
    return unavailableMessages("source_temporarily_unavailable");
  }
};

const taskLocationVisibility = (
  locationIds: readonly string[],
): Record<string, unknown> => {
  const uniqueLocationIds = [
    ...new Set(
      locationIds.map((locationId) => locationId.trim()).filter(Boolean),
    ),
  ];

  // This mirrors the staff-task list boundary: an empty resolved scope must
  // not expose workspace-wide or location-less tasks.
  if (uniqueLocationIds.length === 0) {
    return { _id: { $in: [] } };
  }

  return {
    $or: [
      { appliesToAllLocations: true },
      { appliesToAllLocations: false, locationId: null },
      {
        locationId: {
          $in: uniqueLocationIds.map(
            (locationId) => new mongoose.Types.ObjectId(locationId),
          ),
        },
      },
    ],
  };
};

const loadTaskSignals = async ({
  context,
  modules,
  locationIds,
}: DashboardSignalsInput): Promise<DashboardTaskSignals> => {
  if (modules?.[TENANT_MODULE.STAFF_TASKS] !== true) {
    return unavailableTasks("module_disabled");
  }
  if (
    !hasWorkspacePermission(context.access, WORKSPACE_PERMISSION.TASKS_VIEW)
  ) {
    return unavailableTasks("permission_required");
  }

  try {
    const filter = {
      tenantId: new mongoose.Types.ObjectId(context.tenantId),
      status: { $in: [...openTaskStatuses] },
      ...taskLocationVisibility(locationIds),
    };
    const [rows, openCount] = await Promise.all([
      StaffTaskModel.aggregate([
        { $match: filter },
        {
          $addFields: {
            __dashboardDueDateMissing: {
              $cond: [{ $eq: ["$dueDate", null] }, 1, 0],
            },
            __dashboardPriorityRank: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$priority", STAFF_TASK_PRIORITY.URGENT] },
                    then: 0,
                  },
                  {
                    case: { $eq: ["$priority", STAFF_TASK_PRIORITY.HIGH] },
                    then: 1,
                  },
                  {
                    case: { $eq: ["$priority", STAFF_TASK_PRIORITY.NORMAL] },
                    then: 2,
                  },
                  {
                    case: { $eq: ["$priority", STAFF_TASK_PRIORITY.LOW] },
                    then: 3,
                  },
                ],
                default: 4,
              },
            },
          },
        },
        {
          $sort: {
            __dashboardDueDateMissing: 1,
            dueDate: 1,
            __dashboardPriorityRank: 1,
            createdAt: 1,
            _id: 1,
          },
        },
        { $limit: SIGNAL_LIMIT },
        {
          $project: {
            _id: 1,
            title: 1,
            assignedTo: 1,
            priority: 1,
            dueDate: 1,
          },
        },
      ]),
      StaffTaskModel.countDocuments(filter as never),
    ]);
    const populatedRows = await StaffTaskModel.populate(rows, {
      path: "assignedTo",
      select: "firstname lastname email",
    });

    return {
      available: true,
      reason: null,
      openCount: nonNegativeInteger(openCount),
      items: (Array.isArray(populatedRows) ? populatedRows : [])
        .slice(0, SIGNAL_LIMIT)
        .map((task: any) => ({
          id: entityId(task?._id),
          title: safeText(task?.title, 180),
          assigneeName: assigneeDisplayName(task?.assignedTo),
          priority: safeText(task?.priority, 20),
          dueDate: optionalIsoDate(task?.dueDate),
        })),
    };
  } catch {
    return unavailableTasks("source_temporarily_unavailable");
  }
};

export const loadDashboardSignals = async (
  input: DashboardSignalsInput,
): Promise<DashboardSignals> => {
  const [messages, tasks] = await Promise.all([
    loadMessageSignals(input),
    loadTaskSignals(input),
  ]);

  return { messages, tasks };
};
