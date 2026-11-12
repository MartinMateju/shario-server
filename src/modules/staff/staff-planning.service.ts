import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import mongoose from "mongoose";

import LocationModel from "@/modules/location/location.model.js";
import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
  WORKSPACE_PERMISSION,
  type ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import TenantCustomRoleModel from "@/modules/tenant-access/tenant-custom-role.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import UserModel from "@/modules/user/user.model.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";

import {
  DEFAULT_PLANNING_EXPECTED_UPDATE_TIME,
  DEFAULT_PLANNING_WEEKDAYS,
  STAFF_ATTENTION_STATUS,
  STAFF_TASK_STATUS,
} from "./staff.constants.js";
import {
  assertMondayKey,
  assertMonthKey,
  planningDateRange,
  planningToday,
  resolvePlanningDate,
} from "./staff-planning.date.js";
import {
  StaffDailyUpdateModel,
  StaffMonthlyPrioritySetModel,
  StaffPlanningProfileModel,
  StaffPlanningSettingsModel,
  StaffWeeklyPlanModel,
} from "./staff-planning.models.js";
import type {
  DailyUpdateInput,
  MonthlyPriorityInput,
  PlanningOverviewQuery,
  WeeklyPlanInput,
} from "./staff-planning.validators.js";
import { assertStaffTasksModuleEnabled } from "./staff-entitlement.service.js";
import StaffMemberModel from "./staff-member.model.js";
import { filterVisibleStaffTaskLinks } from "./staff-task-links.service.js";
import StaffTaskModel from "./staff-task.model.js";

dayjs.extend(utc);
dayjs.extend(timezonePlugin);

const PlanningStaffTaskModel =
  StaffTaskModel as unknown as mongoose.Model<any>;
const PlanningStaffMemberModel =
  StaffMemberModel as unknown as mongoose.Model<any>;

export type StaffPlanningContext = {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  now?: Date;
};

const staffRoles = [
  WORKSPACE_ROLE.OWNER,
  WORKSPACE_ROLE.ADMIN,
  WORKSPACE_ROLE.MANAGER,
  WORKSPACE_ROLE.STAFF,
  WORKSPACE_ROLE.CUSTOM,
];

const asId = (value: any) =>
  String(value?._id ?? value?.id ?? value ?? "");

export const staffPlanningEntityId = asId;
export const staffPlanningDocumentId = (document: any) =>
  asId(document?._id);

const uniqueIds = (values: readonly unknown[]) =>
  [...new Set(values.map(asId).filter(Boolean))];

const getTenantTimezone = async (tenantId: string): Promise<string> => {
  const tenant: any = await TenantModel.findById(tenantId)
    .select("settings.timezone")
    .lean();
  if (!tenant) notFound("Workspace not found.");
  return tenant.settings?.timezone || "Europe/Prague";
};

const assertCurrentActiveMembership = async (context: StaffPlanningContext) => {
  const membership: any = await TenantMembershipModel.findOne({
    tenant: context.tenantId,
    user: context.userId,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  }).lean();
  if (!membership) {
    forbidden({
      message: "Active workspace membership is required.",
      code: "STAFF_PLANNING_MEMBERSHIP_REQUIRED",
    });
  }
  return membership;
};

const canTeamView = (context: StaffPlanningContext) =>
  hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
  ) || canManage(context);

const canManage = (context: StaffPlanningContext) =>
  hasWorkspacePermission(context.access, WORKSPACE_PERMISSION.PLANNING_MANAGE);

const assertCanSubmit = (context: StaffPlanningContext) => {
  if (
    !hasWorkspacePermission(
      context.access,
      WORKSPACE_PERMISSION.PLANNING_SUBMIT,
    )
  ) {
    forbidden({
      message: "Staff planning submission permission is required.",
      code: "STAFF_PLANNING_SUBMIT_REQUIRED",
    });
  }
};

const memberOverlapsLocations = (
  membership: any,
  locationIds: readonly string[] | null,
) => {
  if (locationIds === null) return true;
  if (locationIds.length === 0) return false;
  if (membership.locationAccess?.mode === LOCATION_ACCESS_MODE.ALL) return true;
  const memberLocations = new Set(
    (membership.locationAccess?.locationIds || []).map(String),
  );
  return locationIds.some((id) => memberLocations.has(id));
};

export const staffPlanningMemberOverlapsLocations =
  memberOverlapsLocations;

const canManageMemberSchedule = (
  membership: any,
  allowedLocationIds: readonly string[] | null,
) => {
  if (allowedLocationIds === null) return true;
  if (membership?.locationAccess?.mode !== LOCATION_ACCESS_MODE.SELECTED) {
    return false;
  }
  const allowed = new Set(allowedLocationIds.map(String));
  const targetLocationIds = (membership.locationAccess.locationIds || []).map(
    String,
  );
  return (
    targetLocationIds.length > 0 &&
    targetLocationIds.every((id: string) => allowed.has(id))
  );
};

const resolveRequestedLocations = async (
  context: StaffPlanningContext,
  locationId?: string | null,
) => {
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  if (locationId) {
    assertLocationIdsWithinWorkspaceScope([locationId], allowed);
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId: context.tenantId,
      locationIds: [locationId],
      allowedLocationIds: allowed,
    });
    return { requestedLocationId: locationId, locationIds: [locationId], allowed };
  }
  if (allowed !== null) {
    return {
      requestedLocationId: null,
      locationIds: [...allowed],
      allowed,
    };
  }
  const ids = await LocationModel.find({ tenant: context.tenantId })
    .sort({ _id: 1 })
    .distinct("_id");
  return {
    requestedLocationId: null,
    locationIds: ids.map(String),
    allowed,
  };
};

const resolveSubmissionLocation = async (
  context: StaffPlanningContext,
  requested?: string | null,
): Promise<string> => {
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  if (requested) {
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId: context.tenantId,
      locationIds: [requested],
      allowedLocationIds: allowed,
    });
    return requested;
  }
  const preferred = context.access.preferences.defaultLocation;
  if (
    preferred &&
    (allowed === null || allowed.map(String).includes(String(preferred)))
  ) {
    const exists = await LocationModel.exists({
      _id: preferred,
      tenant: context.tenantId,
    });
    if (exists) return String(preferred);
  }
  if (allowed !== null && allowed.length) {
    return [...allowed].map(String).sort()[0]!;
  }
  if (allowed !== null) {
    forbidden({
      message: "No studio location is available in your workspace scope.",
      code: "STAFF_PLANNING_LOCATION_SCOPE_REQUIRED",
    });
  }
  const first = await LocationModel.findOne({ tenant: context.tenantId })
    .sort({ _id: 1 })
    .select("_id")
    .lean();
  if (!first) {
    badRequest({
      message: "Create a studio location before submitting a staff plan.",
      code: "STAFF_PLANNING_LOCATION_REQUIRED",
    });
  }
  return String(first._id);
};

const assertLinkedTasks = async ({
  context,
  taskIds,
  locationId,
}: {
  context: StaffPlanningContext;
  taskIds: readonly string[];
  locationId: string | null;
}) => {
  const ids = uniqueIds(taskIds);
  if (!ids.length) return;
  if (
    !hasWorkspacePermission(context.access, WORKSPACE_PERMISSION.TASKS_VIEW)
  ) {
    forbidden({
      message: "Task visibility is required to link a task.",
      code: "STAFF_PLANNING_TASK_PERMISSION_REQUIRED",
    });
  }
  const tasks: any[] = await PlanningStaffTaskModel.find({
    _id: { $in: ids },
    tenantId: context.tenantId,
  })
    .select("_id locationId appliesToAllLocations")
    .lean();
  if (tasks.length !== ids.length) notFound("Linked task not found.");
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  for (const task of tasks) {
    if (task.locationId) {
      assertLocationIdsWithinWorkspaceScope([task.locationId], allowed);
      if (locationId && String(task.locationId) !== locationId) {
        badRequest({
          message: "A linked task belongs to another location.",
          code: "STAFF_PLANNING_TASK_LOCATION_MISMATCH",
        });
      }
    }
  }
};

const visibleTaskIdsForPlanning = async (
  context: StaffPlanningContext,
  taskIds: readonly unknown[],
  recordLocationId: string | null = null,
) => {
  const ids = uniqueIds(taskIds);
  if (!ids.length) return new Set<string>();
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  if (allowed !== null && allowed.length === 0) {
    return new Set<string>();
  }
  const scopeFilters: Record<string, unknown>[] = [];
  if (allowed !== null) {
    scopeFilters.push({
      $or: [
        { appliesToAllLocations: true },
        { appliesToAllLocations: false, locationId: null },
        { locationId: { $in: allowed } },
      ],
    });
  }
  if (recordLocationId) {
    scopeFilters.push({
      $or: [
        { appliesToAllLocations: true },
        { appliesToAllLocations: false, locationId: null },
        { locationId: recordLocationId },
      ],
    });
  }
  const tasks: any[] = await PlanningStaffTaskModel.find({
    tenantId: context.tenantId,
    _id: { $in: ids },
    ...(scopeFilters.length ? { $and: scopeFilters } : {}),
  })
    .select("_id")
    .lean();
  return new Set(tasks.map((task) => asId(task._id)));
};

const assertActivePriorityOwner = async ({
  tenantId,
  userId,
  locationId,
}: {
  tenantId: string;
  userId: string;
  locationId: string | null;
}) => {
  const membership: any = await TenantMembershipModel.findOne({
    tenant: tenantId,
    user: userId,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  })
    .select("locationAccess")
    .lean();
  if (!membership) notFound("Priority owner not found.");
  if (
    !locationId &&
    membership.locationAccess?.mode === LOCATION_ACCESS_MODE.SELECTED
  ) {
    notFound("Priority owner not found.");
  }
  if (
    locationId &&
    membership.locationAccess?.mode === LOCATION_ACCESS_MODE.SELECTED &&
    !(membership.locationAccess.locationIds || [])
      .map(String)
      .includes(locationId)
  ) {
    notFound("Priority owner not found.");
  }
};

const safeUpsert = async (
  model: mongoose.Model<any>,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) => {
  try {
    return await model.findOneAndUpdate(filter, update, {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    return model.findOneAndUpdate(filter, update, {
      returnDocument: "after",
      runValidators: true,
    });
  }
};

const serializedUpdate = (
  update: any,
  canViewTasks = true,
  visibleTaskIds?: ReadonlySet<string>,
) =>
  update
    ? {
        id: asId(update._id),
        userId: asId(update.userId),
        date: update.dateKey,
        locationId: asId(update.locationId) || null,
        focusToday: update.focusToday || "",
        completedSinceLast: update.completedSinceLast || "",
        blockers: update.blockers || "",
        notWorkingToday: update.notWorkingToday === true,
        needsOwnerAttention: update.needsOwnerAttention === true,
        attentionStatus: update.attentionStatus || STAFF_ATTENTION_STATUS.NONE,
        ...(canViewTasks
          ? {
              linkedTaskIds: (update.linkedTaskIds || [])
                .map(String)
                .filter(
                  (id: string) => !visibleTaskIds || visibleTaskIds.has(id),
                ),
            }
          : {}),
        submittedAt: update.submittedAt,
        updatedAt: update.updatedAt,
      }
    : null;

const serializedPlan = (
  plan: any,
  canViewTasks = true,
  visibleTaskIds?: ReadonlySet<string>,
) => ({
  id: asId(plan._id),
  userId: asId(plan.userId),
  weekStart: plan.weekStartKey,
  locationId: asId(plan.locationId) || null,
  outcomes: (plan.outcomes || []).map((outcome: any) => ({
    id: asId(outcome._id),
    title: outcome.title,
    completed: outcome.completed === true,
    ...(canViewTasks
      ? {
          linkedTaskIds: (outcome.linkedTaskIds || [])
            .map(String)
            .filter(
              (id: string) => !visibleTaskIds || visibleTaskIds.has(id),
            ),
        }
      : {}),
  })),
  submittedAt: plan.submittedAt,
  updatedAt: plan.updatedAt,
});

const serializedPrioritySet = (
  set: any,
  canViewTasks = true,
  visibleTaskIds?: ReadonlySet<string>,
) => ({
  id: asId(set._id),
  month: set.monthKey,
  locationId: asId(set.locationId) || null,
  priorities: (set.priorities || []).map((priority: any) => ({
    id: asId(priority._id),
    title: priority.title,
    ownerUserId: asId(priority.ownerUserId) || null,
    completed: priority.completed === true,
    ...(canViewTasks
      ? {
          linkedTaskIds: (priority.linkedTaskIds || [])
            .map(String)
            .filter(
              (id: string) => !visibleTaskIds || visibleTaskIds.has(id),
            ),
        }
      : {}),
  })),
  updatedAt: set.updatedAt,
});

const planningDueAt = (
  dateKey: string,
  expectedUpdateTime: string,
  timezone: string,
): Date =>
  dayjs.tz(
    `${dateKey} ${expectedUpdateTime}`,
    "YYYY-MM-DD HH:mm",
    timezone,
  ).toDate();

export const getStaffPlanningOverview = async (
  context: StaffPlanningContext,
  query: PlanningOverviewQuery,
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  await assertCurrentActiveMembership(context);
  const timezone = await getTenantTimezone(context.tenantId);
  const date = resolvePlanningDate(query.date, timezone, context.now);
  const range = planningDateRange(date, timezone);
  const locationScope = await resolveRequestedLocations(
    context,
    query.locationId,
  );
  const teamVisible = canTeamView(context);
  const manager = canManage(context);
  const tasksVisible = hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  );
  const settings: any =
    (await StaffPlanningSettingsModel.findOne({
      tenantId: context.tenantId,
    }).lean()) || {};
  const expectedUpdateTime =
    settings.expectedUpdateTime || DEFAULT_PLANNING_EXPECTED_UPDATE_TIME;

  const membershipFilter: Record<string, unknown> = {
    tenant: context.tenantId,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
    role: { $in: staffRoles },
  };
  const allMemberships: any[] = await TenantMembershipModel.find(
    membershipFilter,
  )
    .populate({ path: "user", select: "firstname lastname" })
    .lean();
  const customRoleIds = uniqueIds(
    allMemberships.map((membership) => membership.customRole),
  );
  const customRoles: any[] = customRoleIds.length
    ? await TenantCustomRoleModel.find({
        _id: { $in: customRoleIds },
        tenant: context.tenantId,
        isActive: true,
      })
        .select("permissions")
        .lean()
    : [];
  const customRolePermissions = new Map(
    customRoles.map((role) => [
      asId(role._id),
      new Set((role.permissions || []).map(String)),
    ]),
  );
  const membershipCanSubmit = (membership: any) =>
    membership.role !== WORKSPACE_ROLE.CUSTOM ||
    customRolePermissions
      .get(asId(membership.customRole))
      ?.has(WORKSPACE_PERMISSION.PLANNING_SUBMIT) === true;
  const scopedMemberships = allMemberships.filter(
    (membership) =>
      membershipCanSubmit(membership) &&
      memberOverlapsLocations(membership, locationScope.locationIds) &&
      (teamVisible || asId(membership.user) === context.userId),
  );
  const scopedUserIds = scopedMemberships.map((member) => asId(member.user));
  const [
    profiles,
    updates,
    plans,
    prioritySets,
    staffProfiles,
    myDailyUpdate,
    myWeeklyPlan,
  ] =
    await Promise.all([
      StaffPlanningProfileModel.find({
        tenantId: context.tenantId,
        userId: { $in: scopedUserIds },
      }).lean(),
      StaffDailyUpdateModel.find({
        tenantId: context.tenantId,
        userId: { $in: scopedUserIds },
        dateKey: date,
        ...(query.locationId
          ? { locationId: query.locationId }
          : locationScope.allowed !== null
            ? { locationId: { $in: locationScope.locationIds } }
            : {}),
      }).lean(),
      StaffWeeklyPlanModel.find({
        tenantId: context.tenantId,
        userId: {
          $in: teamVisible ? scopedUserIds : [context.userId],
        },
        weekStartKey: range.week.from,
        ...(query.locationId
          ? { locationId: query.locationId }
          : locationScope.allowed !== null
            ? { locationId: { $in: locationScope.locationIds } }
            : {}),
      }).lean(),
      StaffMonthlyPrioritySetModel.find({
            tenantId: context.tenantId,
            monthKey: range.month.key,
            ...(query.locationId
              ? { $or: [{ locationId: query.locationId }, { locationId: null }] }
              : locationScope.allowed !== null
                ? locationScope.allowed.length
                  ? {
                    $or: [
                      { locationId: { $in: locationScope.locationIds } },
                      { locationId: null },
                    ],
                    }
                  : { _id: { $in: [] } }
                : {}),
          }).lean(),
      PlanningStaffMemberModel.find({
        tenantId: context.tenantId,
        isActive: true,
        ...(query.locationId
          ? { locationIds: query.locationId }
          : locationScope.allowed !== null
            ? { locationIds: { $in: locationScope.locationIds } }
            : {}),
      })
        .select("userId firstName lastName avatarUrl locationIds")
        .lean(),
      StaffDailyUpdateModel.findOne({
        tenantId: context.tenantId,
        userId: context.userId,
        dateKey: date,
      }).lean(),
      StaffWeeklyPlanModel.findOne({
        tenantId: context.tenantId,
        userId: context.userId,
        weekStartKey: range.week.from,
      }).lean(),
    ]);

  const updateDocuments = [
    ...updates,
    ...(myDailyUpdate ? [myDailyUpdate] : []),
  ];
  const planDocuments = [
    ...plans,
    ...(myWeeklyPlan ? [myWeeklyPlan] : []),
  ];
  const updateVisibility = new Map<string, Set<string>>(
    tasksVisible
      ? await Promise.all(
          [...new Map(
            updateDocuments.map((update: any) => [asId(update._id), update]),
          ).values()].map(async (update: any) =>
            [
              asId(update._id),
              await visibleTaskIdsForPlanning(
                context,
                update.linkedTaskIds || [],
                asId(update.locationId) || null,
              ),
            ] as const,
          ),
        )
      : [],
  );
  const planVisibility = new Map<string, Set<string>>(
    tasksVisible
      ? await Promise.all(
          [...new Map(
            planDocuments.map((plan: any) => [asId(plan._id), plan]),
          ).values()].map(async (plan: any) =>
            [
              asId(plan._id),
              await visibleTaskIdsForPlanning(
                context,
                (plan.outcomes || []).flatMap(
                  (outcome: any) => outcome.linkedTaskIds || [],
                ),
                asId(plan.locationId) || null,
              ),
            ] as const,
          ),
        )
      : [],
  );

  const profileByUser = new Map(profiles.map((profile: any) => [
    asId(profile.userId),
    profile,
  ]));
  const updateByUser = new Map(updates.map((update: any) => [
    asId(update.userId),
    update,
  ]));
  const staffByUser = new Map(
    staffProfiles
      .filter((staff: any) => staff.userId)
      .map((staff: any) => [asId(staff.userId), staff]),
  );
  const dueAt = planningDueAt(date, expectedUpdateTime, timezone);
  const todayKey = planningToday(timezone, context.now);
  const now = context.now ?? new Date();
  const members: any[] = scopedMemberships.map((membership: any) => {
    const userId = asId(membership.user);
    const user: any = membership.user || {};
    const profile: any = profileByUser.get(userId);
    const staff: any = staffByUser.get(userId);
    const update: any = updateByUser.get(userId);
    const expectedWeekdays: number[] =
      profile
        ? profile.expectedWeekdays
        : membership.role === WORKSPACE_ROLE.STAFF
          ? [...DEFAULT_PLANNING_WEEKDAYS]
          : [];
    const isExpectedToday = expectedWeekdays.includes(range.isoWeekday);
    let state = "not-expected";
    if (update?.notWorkingToday) state = "not-working";
    else if (update?.attentionStatus === STAFF_ATTENTION_STATUS.RESOLVED)
      state = "submitted";
    else if (update?.needsOwnerAttention && update.attentionStatus !== STAFF_ATTENTION_STATUS.RESOLVED)
      state = "needs-attention";
    else if (update?.blockers) state = "blocked";
    else if (update) state = "submitted";
    else if (isExpectedToday) {
      state =
        date < todayKey || (date === todayKey && now >= dueAt)
          ? "missing"
          : "waiting";
    }
    return {
      memberId: asId(membership._id),
      userId,
      displayName:
        membership.workspaceProfile?.displayName ||
        [user.firstname, user.lastname].filter(Boolean).join(" ") ||
        [staff?.firstName, staff?.lastName].filter(Boolean).join(" "),
      avatarUrl: staff?.avatarUrl || "",
      canSubmit: true,
      canManageSchedule:
        manager && canManageMemberSchedule(membership, locationScope.allowed),
      expectedWeekdays,
      isExpectedToday,
      state,
      update:
        teamVisible || userId === context.userId
          ? serializedUpdate(
              update,
              tasksVisible,
              updateVisibility.get(staffPlanningDocumentId(update)),
            )
          : update
            ? {
                id: asId(update._id),
                userId,
                submittedAt: update.submittedAt,
                state,
              }
            : null,
    };
  });

  if (teamVisible) {
    const linkedUserIds = new Set(scopedUserIds);
    for (const staff of staffProfiles as any[]) {
      if (staff.userId && linkedUserIds.has(asId(staff.userId))) continue;
      members.push({
        memberId: `staff:${asId(staff._id)}`,
        staffMemberId: asId(staff._id),
        userId: null,
        displayName: [staff.firstName, staff.lastName].filter(Boolean).join(" "),
        avatarUrl: staff.avatarUrl || "",
        canSubmit: false,
        canManageSchedule: false,
        expectedWeekdays: [],
        isExpectedToday: false,
        state: "not-linked",
        update: null,
      });
    }
  }

  const taskResult =
    tasksVisible &&
    !(locationScope.allowed !== null && locationScope.allowed.length === 0)
    ? await import("./staff.repository.js").then(
        ({ createStaffRepository }) =>
          createStaffRepository({ tenantId: context.tenantId }).listTasks({
            ...(query.locationId ? { locationId: query.locationId } : {}),
            allowedLocationIds: locationScope.allowed,
            limit: 100,
          }),
      )
    : { tasks: [] };
  const priorityVisibility = new Map<string, Set<string>>(
    tasksVisible
      ? await Promise.all(
          prioritySets.map(async (set: any) =>
            [
              asId(set._id),
              await visibleTaskIdsForPlanning(
                context,
                (set.priorities || []).flatMap(
                  (priority: any) => priority.linkedTaskIds || [],
                ),
                asId(set.locationId) || null,
              ),
            ] as const,
          ),
        )
      : [],
  );
  const boardTaskRows = await Promise.all(
    (taskResult.tasks as any[]).map(async (task) => ({
      task,
      links: await filterVisibleStaffTaskLinks({
        tenantId: context.tenantId,
        allowedLocationIds: locationScope.allowed,
        taskLocationId: asId(task.locationId) || null,
        links: task.links || [],
      }),
    })),
  );
  const boardTasks = boardTaskRows.map(({ task, links }) => ({
    id: asId(task._id),
    title: task.title,
    description: task.description || "",
    locationId: asId(task.locationId) || null,
    appliesToAllLocations: task.appliesToAllLocations === true,
    assignedTo: task.assignedTo
      ? {
          userId: asId(task.assignedTo),
          displayName: [
            task.assignedTo.firstname,
            task.assignedTo.lastname,
          ]
            .filter(Boolean)
            .join(" "),
        }
      : null,
    dueDate: task.dueDate || null,
    completedAt: task.completedAt || null,
    status: task.status,
    column:
      task.status === STAFF_TASK_STATUS.BLOCKED ||
      task.status === STAFF_TASK_STATUS.WAITING
        ? "waiting"
        : task.status,
    priority: task.priority,
    blockerReason: task.blockerReason || "",
    category: task.category,
    links: links.map((link: any) => ({
      type: link.type,
      resourceId: asId(link.resourceId),
      label: link.label || "",
    })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));
  const stateCount = (state: string) =>
    members.filter((member) => member.state === state).length;

  return {
    metadata: {
      date,
      timezone,
      locationId: query.locationId || null,
      week: range.week,
      month: range.month,
      generatedAt: now.toISOString(),
    },
    permissions: {
      canSubmit: hasWorkspacePermission(
        context.access,
        WORKSPACE_PERMISSION.PLANNING_SUBMIT,
      ),
      canViewTeam: teamVisible,
      canManage: manager,
      canManageGlobalSettings:
        manager && getAllowedWorkspaceLocationIds(context.access) === null,
    },
    settings: {
      expectedUpdateTime,
      dueAt: dueAt.toISOString(),
      notificationDeliveryEnabled: false,
    },
    today: {
      myUpdate: serializedUpdate(
        myDailyUpdate,
        tasksVisible,
        updateVisibility.get(asId(myDailyUpdate?._id)),
      ),
      staff: members,
      counts: {
        submitted: stateCount("submitted"),
        waiting: stateCount("waiting"),
        missing: stateCount("missing"),
        blocked: stateCount("blocked"),
        needsOwnerAttention: stateCount("needs-attention"),
        notWorking: stateCount("not-working"),
        notLinked: stateCount("not-linked"),
      },
    },
    week: {
      myPlan: myWeeklyPlan
        ? serializedPlan(
            myWeeklyPlan,
            tasksVisible,
            planVisibility.get(asId(myWeeklyPlan._id)),
          )
        : null,
      plans: plans.map((plan: any) =>
        serializedPlan(
          plan,
          tasksVisible,
          planVisibility.get(asId(plan._id)),
        ),
      ),
    },
    month: {
      prioritySets: prioritySets.map((set: any) =>
        serializedPrioritySet(
          set,
          tasksVisible,
          priorityVisibility.get(asId(set._id)),
        ),
      ),
    },
    board: {
      columns: [
        { key: "todo", label: "To do" },
        { key: "in-progress", label: "In progress" },
        { key: "waiting", label: "Waiting" },
        { key: "done", label: "Done" },
      ],
      tasks: boardTasks,
    },
  };
};

export const upsertDailyUpdate = async (
  context: StaffPlanningContext,
  dateInput: string,
  input: DailyUpdateInput,
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  assertCanSubmit(context);
  await assertCurrentActiveMembership(context);
  const timezone = await getTenantTimezone(context.tenantId);
  const dateKey = resolvePlanningDate(dateInput, timezone, context.now);
  const existing: any = await StaffDailyUpdateModel.findOne({
    tenantId: context.tenantId,
    userId: context.userId,
    dateKey,
  })
    .select("attentionStatus locationId linkedTaskIds")
    .lean();
  const locationId = await resolveSubmissionLocation(
    context,
    input.locationId === undefined
      ? asId(existing?.locationId) || undefined
      : input.locationId,
  );
  const notWorking = input.notWorkingToday === true;
  const tasksVisible = hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  );
  const existingTaskIds = uniqueIds(existing?.linkedTaskIds || []);
  const effectiveTaskIds = tasksVisible
    ? input.linkedTaskIds !== undefined
      ? uniqueIds(input.linkedTaskIds)
      : existingTaskIds
    : existingTaskIds;
  const locationChanged =
    Boolean(existing) &&
    (asId(existing.locationId) || null) !== locationId;
  if (!tasksVisible && locationChanged && effectiveTaskIds.length) {
    conflict({
      message: "This daily update cannot be moved to that location.",
      code: "STAFF_PLANNING_LOCATION_CHANGE_CONFLICT",
    });
  }
  if (!notWorking && effectiveTaskIds.length) {
    if (tasksVisible) {
      await assertLinkedTasks({
        context,
        taskIds: effectiveTaskIds,
        locationId,
      });
    }
  }
  const needsAttention = !notWorking && input.needsOwnerAttention === true;
  const attentionStatus = needsAttention
    ? existing?.attentionStatus === STAFF_ATTENTION_STATUS.ACKNOWLEDGED
      ? STAFF_ATTENTION_STATUS.ACKNOWLEDGED
      : STAFF_ATTENTION_STATUS.NEEDS_ATTENTION
    : STAFF_ATTENTION_STATUS.NONE;
  const document = await safeUpsert(
    StaffDailyUpdateModel,
    {
      tenantId: context.tenantId,
      userId: context.userId,
      dateKey,
    },
    {
      $set: {
        locationId,
        focusToday: notWorking ? "" : input.focusToday,
        completedSinceLast: notWorking ? "" : input.completedSinceLast,
        blockers: notWorking ? "" : input.blockers,
        notWorkingToday: notWorking,
        needsOwnerAttention: needsAttention,
        attentionStatus,
        ...(attentionStatus === STAFF_ATTENTION_STATUS.NONE
          ? {
              attentionAcknowledgedAt: null,
              attentionAcknowledgedBy: null,
              attentionResolvedAt: null,
              attentionResolvedBy: null,
            }
          : {}),
        linkedTaskIds: notWorking
          ? tasksVisible
            ? []
            : existingTaskIds
          : effectiveTaskIds,
        submittedAt: context.now ?? new Date(),
      },
      $setOnInsert: {
        tenantId: context.tenantId,
        userId: context.userId,
        dateKey,
      },
    },
  );
  const visibleTaskIds = tasksVisible
    ? await visibleTaskIdsForPlanning(
        context,
        document.linkedTaskIds || [],
        asId(document.locationId) || null,
      )
    : new Set<string>();
  return serializedUpdate(document, tasksVisible, visibleTaskIds);
};

export const upsertWeeklyPlan = async (
  context: StaffPlanningContext,
  weekStartInput: string,
  input: WeeklyPlanInput,
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  assertCanSubmit(context);
  await assertCurrentActiveMembership(context);
  const timezone = await getTenantTimezone(context.tenantId);
  const weekStartKey = assertMondayKey(weekStartInput, timezone);
  const existing: any = await StaffWeeklyPlanModel.findOne({
    tenantId: context.tenantId,
    userId: context.userId,
    weekStartKey,
  })
    .select("locationId outcomes")
    .lean();
  const locationId = await resolveSubmissionLocation(
    context,
    input.locationId === undefined
      ? asId(existing?.locationId) || undefined
      : input.locationId,
  );
  const existingOutcomes = new Map<string, any>(
    (existing?.outcomes || []).map((outcome: any) => [
      asId(outcome._id),
      outcome,
    ]),
  );
  const tasksVisible = hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  );
  const resolvedOutcomes = input.outcomes.map((outcome) => {
    if (outcome.id && !existingOutcomes.has(outcome.id)) {
      badRequest({
        message: "Weekly outcome does not belong to this plan.",
        code: "STAFF_PLANNING_OUTCOME_MISMATCH",
      });
    }
    const existingOutcome = outcome.id
      ? existingOutcomes.get(outcome.id)
      : null;
    const linkedTaskIds = tasksVisible
      ? outcome.linkedTaskIds !== undefined
        ? uniqueIds(outcome.linkedTaskIds)
        : uniqueIds(existingOutcome?.linkedTaskIds || [])
      : uniqueIds(existingOutcome?.linkedTaskIds || []);
    return {
      ...(outcome.id ? { _id: outcome.id } : {}),
      title: outcome.title,
      completed: outcome.completed,
      linkedTaskIds,
    };
  });
  const locationChanged =
    Boolean(existing) &&
    (asId(existing.locationId) || null) !== locationId;
  if (
    !tasksVisible &&
    locationChanged &&
    resolvedOutcomes.some((outcome) => outcome.linkedTaskIds.length > 0)
  ) {
    conflict({
      message: "This weekly plan cannot be moved to that location.",
      code: "STAFF_PLANNING_LOCATION_CHANGE_CONFLICT",
    });
  }
  if (tasksVisible) {
    for (const outcome of resolvedOutcomes) {
      await assertLinkedTasks({
        context,
        taskIds: outcome.linkedTaskIds,
        locationId,
      });
    }
  }
  const plan = await safeUpsert(
    StaffWeeklyPlanModel,
    {
      tenantId: context.tenantId,
      userId: context.userId,
      weekStartKey,
    },
    {
      $set: {
        locationId,
        outcomes: resolvedOutcomes,
        submittedAt: context.now ?? new Date(),
      },
      $setOnInsert: {
        tenantId: context.tenantId,
        userId: context.userId,
        weekStartKey,
      },
    },
  );
  const visibleTaskIds = tasksVisible
    ? await visibleTaskIdsForPlanning(
        context,
        (plan.outcomes || []).flatMap(
          (outcome: any) => outcome.linkedTaskIds || [],
        ),
        asId(plan.locationId) || null,
      )
    : new Set<string>();
  return serializedPlan(plan, tasksVisible, visibleTaskIds);
};

export const upsertMonthlyPriorities = async (
  context: StaffPlanningContext,
  monthInput: string,
  input: MonthlyPriorityInput,
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  if (!canManage(context)) forbidden("Staff planning management is required.");
  await assertCurrentActiveMembership(context);
  const timezone = await getTenantTimezone(context.tenantId);
  const monthKey = assertMonthKey(monthInput, timezone);
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  const locationId = input.locationId || null;
  if (locationId) {
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId: context.tenantId,
      locationIds: [locationId],
      allowedLocationIds: allowed,
    });
  } else {
    assertCanAccessAllWorkspaceLocations(allowed);
  }
  const existing: any = await StaffMonthlyPrioritySetModel.findOne({
    tenantId: context.tenantId,
    monthKey,
    locationId,
  })
    .select("priorities")
    .lean();
  const existingPriorities = new Map<string, any>(
    (existing?.priorities || []).map((priority: any) => [
      asId(priority._id),
      priority,
    ]),
  );
  const tasksVisible = hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  );
  const visibleExistingTaskIds = tasksVisible
      ? await visibleTaskIdsForPlanning(
          context,
          [...existingPriorities.values()].flatMap(
            (priority: any) => priority.linkedTaskIds || [],
          ),
          locationId,
        )
    : new Set<string>();
  const resolvedPriorities = input.priorities.map((priority) => {
    if (priority.id && !existingPriorities.has(priority.id)) {
      badRequest({
        message: "Monthly priority does not belong to this priority set.",
        code: "STAFF_PLANNING_PRIORITY_MISMATCH",
      });
    }
    const existingPriority = priority.id
      ? existingPriorities.get(priority.id)
      : null;
    const existingLinkedTaskIds = uniqueIds(
      existingPriority?.linkedTaskIds || [],
    );
    const hiddenExistingTaskIds = existingLinkedTaskIds.filter(
      (id) => !visibleExistingTaskIds.has(id),
    );
    return {
      ...(priority.id ? { _id: priority.id } : {}),
      title: priority.title,
      ownerUserId: priority.ownerUserId,
      completed: priority.completed,
      linkedTaskIds: tasksVisible
        ? priority.linkedTaskIds !== undefined
          ? uniqueIds([
              ...hiddenExistingTaskIds,
              ...priority.linkedTaskIds,
            ])
          : existingLinkedTaskIds
        : existingLinkedTaskIds,
    };
  });
  for (const priority of input.priorities) {
    if (priority.ownerUserId) {
      await assertActivePriorityOwner({
        tenantId: context.tenantId,
        userId: priority.ownerUserId,
        locationId,
      });
    }
  }
  if (tasksVisible) {
    for (const priority of input.priorities) {
      if (priority.linkedTaskIds !== undefined) {
        await assertLinkedTasks({
          context,
          taskIds: priority.linkedTaskIds,
          locationId,
        });
      }
    }
  }
  const set = await safeUpsert(
    StaffMonthlyPrioritySetModel,
    { tenantId: context.tenantId, monthKey, locationId },
    {
      $set: {
        priorities: resolvedPriorities,
        updatedBy: context.userId,
      },
      $setOnInsert: {
        tenantId: context.tenantId,
        monthKey,
        locationId,
      },
    },
  );
  const visibleTaskIds = tasksVisible
    ? await visibleTaskIdsForPlanning(
        context,
        resolvedPriorities.flatMap(
          (priority) => priority.linkedTaskIds,
        ),
        locationId,
      )
    : new Set<string>();
  return serializedPrioritySet(set, tasksVisible, visibleTaskIds);
};

export const updatePlanningSettings = async (
  context: StaffPlanningContext,
  input: { expectedUpdateTime: string },
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  if (!canManage(context)) forbidden("Staff planning management is required.");
  assertCanAccessAllWorkspaceLocations(
    getAllowedWorkspaceLocationIds(context.access),
  );
  const settings = await safeUpsert(
    StaffPlanningSettingsModel,
    { tenantId: context.tenantId },
    {
      $set: {
        expectedUpdateTime: input.expectedUpdateTime,
        updatedBy: context.userId,
      },
      $setOnInsert: { tenantId: context.tenantId },
    },
  );
  return {
    expectedUpdateTime: settings.expectedUpdateTime,
    notificationDeliveryEnabled: false,
  };
};

export const updateMemberSchedule = async (
  context: StaffPlanningContext,
  membershipId: string,
  input: { expectedWeekdays: number[] },
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  if (!canManage(context)) forbidden("Staff planning management is required.");
  const membership: any = await TenantMembershipModel.findOne({
    _id: membershipId,
    tenant: context.tenantId,
    status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
  }).lean();
  const allowed = getAllowedWorkspaceLocationIds(context.access);
  const targetIsFullyWithinScope = canManageMemberSchedule(
    membership,
    allowed,
  );
  if (!membership || !targetIsFullyWithinScope) {
    notFound("Workspace member not found.");
  }
  const profile = await safeUpsert(
    StaffPlanningProfileModel,
    { tenantId: context.tenantId, userId: membership.user },
    {
      $set: {
        expectedWeekdays: [...input.expectedWeekdays].sort(),
        updatedBy: context.userId,
      },
      $setOnInsert: {
        tenantId: context.tenantId,
        userId: membership.user,
      },
    },
  );
  return {
    memberId: asId(membership._id),
    userId: asId(membership.user),
    expectedWeekdays: profile.expectedWeekdays,
  };
};

export const updateDailyAttention = async (
  context: StaffPlanningContext,
  updateId: string,
  status: "acknowledged" | "resolved",
) => {
  await assertStaffTasksModuleEnabled(context.tenantId);
  if (!canManage(context)) forbidden("Staff planning management is required.");
  const update: any = await StaffDailyUpdateModel.findOne({
    _id: updateId,
    tenantId: context.tenantId,
  }).lean();
  if (!update) notFound("Daily update not found.");
  if (update.locationId) {
    assertLocationIdsWithinWorkspaceScope(
      [update.locationId],
      getAllowedWorkspaceLocationIds(context.access),
    );
  } else if (getAllowedWorkspaceLocationIds(context.access) !== null) {
    // A legacy null scope is tenant-global/ambiguous. Only an all-location
    // manager may mutate it; overlap with the submitter is not sufficient.
    notFound("Daily update not found.");
  }
  if (!update.needsOwnerAttention) {
    badRequest({
      message: "This update does not need owner attention.",
      code: "STAFF_PLANNING_ATTENTION_NOT_REQUESTED",
    });
  }
  const now = context.now ?? new Date();
  const patch =
    status === "resolved"
      ? {
          attentionStatus: STAFF_ATTENTION_STATUS.RESOLVED,
          attentionResolvedAt: now,
          attentionResolvedBy: context.userId,
        }
      : {
          attentionStatus: STAFF_ATTENTION_STATUS.ACKNOWLEDGED,
          attentionAcknowledgedAt: now,
          attentionAcknowledgedBy: context.userId,
          attentionResolvedAt: null,
          attentionResolvedBy: null,
        };
  const updated = await StaffDailyUpdateModel.findOneAndUpdate(
    {
      _id: updateId,
      tenantId: context.tenantId,
      locationId: update.locationId || null,
      needsOwnerAttention: true,
    },
    { $set: patch },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) notFound("Daily update not found.");
  const tasksVisible = hasWorkspacePermission(
    context.access,
    WORKSPACE_PERMISSION.TASKS_VIEW,
  );
  const visibleTaskIds = tasksVisible
    ? await visibleTaskIdsForPlanning(
        context,
        updated?.linkedTaskIds || [],
        asId(updated?.locationId) || null,
      )
    : new Set<string>();
  return serializedUpdate(updated, tasksVisible, visibleTaskIds);
};

export const staffPlanningService = {
  overview: getStaffPlanningOverview,
  upsertDaily: upsertDailyUpdate,
  upsertWeekly: upsertWeeklyPlan,
  upsertMonthly: upsertMonthlyPriorities,
  updateSettings: updatePlanningSettings,
  updateSchedule: updateMemberSchedule,
  updateAttention: updateDailyAttention,
};
