import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { staffPlanningService } from "../staff-planning.service.js";
import {
  attentionInputSchema,
  dailyUpdateInputSchema,
  monthlyPriorityInputSchema,
  planningDailyUpdateParamsSchema,
  planningDateParamsSchema,
  planningMemberParamsSchema,
  planningMonthParamsSchema,
  planningOverviewQuerySchema,
  planningScheduleInputSchema,
  planningSettingsInputSchema,
  planningWeekParamsSchema,
  weeklyPlanInputSchema,
} from "../staff-planning.validators.js";

const contextFrom = (req: Request) => ({
  tenantId: requireTenantId(req),
  userId: getAuthenticatedUserId(req),
  access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
});

const ok = (res: Response, data: unknown, status = 200) =>
  res.status(status).json({ data });

export const getStaffPlanningOverview = asyncHandler(async (req, res) =>
  ok(
    res,
    await staffPlanningService.overview(
      contextFrom(req),
      planningOverviewQuerySchema.parse(req.query),
    ),
  ),
);

export const putDailyUpdate = asyncHandler(async (req, res) => {
  const { date } = planningDateParamsSchema.parse(req.params);
  ok(
    res,
    await staffPlanningService.upsertDaily(
      contextFrom(req),
      date,
      dailyUpdateInputSchema.parse(req.body),
    ),
  );
});

export const putWeeklyPlan = asyncHandler(async (req, res) => {
  const { weekStart } = planningWeekParamsSchema.parse(req.params);
  ok(
    res,
    await staffPlanningService.upsertWeekly(
      contextFrom(req),
      weekStart,
      weeklyPlanInputSchema.parse(req.body),
    ),
  );
});

export const putMonthlyPriorities = asyncHandler(async (req, res) => {
  const { month } = planningMonthParamsSchema.parse(req.params);
  ok(
    res,
    await staffPlanningService.upsertMonthly(
      contextFrom(req),
      month,
      monthlyPriorityInputSchema.parse(req.body),
    ),
  );
});

export const putPlanningSettings = asyncHandler(async (req, res) =>
  ok(
    res,
    await staffPlanningService.updateSettings(
      contextFrom(req),
      planningSettingsInputSchema.parse(req.body),
    ),
  ),
);

export const putMemberSchedule = asyncHandler(async (req, res) => {
  const { memberId } = planningMemberParamsSchema.parse(req.params);
  ok(
    res,
    await staffPlanningService.updateSchedule(
      contextFrom(req),
      memberId,
      planningScheduleInputSchema.parse(req.body),
    ),
  );
});

export const patchDailyAttention = asyncHandler(async (req, res) => {
  const { id } = planningDailyUpdateParamsSchema.parse(req.params);
  const { status } = attentionInputSchema.parse(req.body);
  ok(
    res,
    await staffPlanningService.updateAttention(contextFrom(req), id, status),
  );
});

