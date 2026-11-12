import mongoose from "mongoose";
import { z } from "zod";

import {
  MAX_MONTHLY_PRIORITIES,
  MAX_WEEKLY_OUTCOMES,
} from "./staff.constants.js";

const objectId = (label: string) =>
  z.string().trim().refine((value) => mongoose.isValidObjectId(value), {
    message: `Invalid ${label}.`,
  });

const nullableLocationId = objectId("location id").nullable().optional();
const taskIds = z.array(objectId("task id")).max(20);

export const planningOverviewQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  locationId: objectId("location id").optional(),
}).strict();

export const planningDateParamsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const planningWeekParamsSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const planningMonthParamsSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
}).strict();

export const planningMemberParamsSchema = z.object({
  memberId: objectId("workspace member id"),
}).strict();

export const planningDailyUpdateParamsSchema = z.object({
  id: objectId("daily update id"),
}).strict();

export const dailyUpdateInputSchema = z.object({
  focusToday: z.string().trim().max(4_000).default(""),
  completedSinceLast: z.string().trim().max(4_000).default(""),
  blockers: z.string().trim().max(4_000).default(""),
  notWorkingToday: z.boolean().default(false),
  needsOwnerAttention: z.boolean().default(false),
  locationId: nullableLocationId,
  linkedTaskIds: taskIds.optional(),
}).strict().superRefine((value, context) => {
  if (!value.notWorkingToday && !value.focusToday) {
    context.addIssue({
      code: "custom",
      path: ["focusToday"],
      message: "Today's focus is required unless the member is not working.",
    });
  }
  if (value.needsOwnerAttention && !value.blockers) {
    context.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "Describe the blocker that needs owner attention.",
    });
  }
});

const weeklyOutcome = z.object({
  id: objectId("weekly outcome id").optional(),
  title: z.string().trim().min(1).max(240),
  completed: z.boolean().default(false),
  linkedTaskIds: taskIds.optional(),
}).strict();

const hasUniqueRowIds = (rows: Array<{ id?: string }>) => {
  const ids = rows.flatMap((row) => (row.id ? [row.id] : []));
  return ids.length === new Set(ids).size;
};

export const weeklyPlanInputSchema = z.object({
  locationId: nullableLocationId,
  outcomes: z
    .array(weeklyOutcome)
    .max(MAX_WEEKLY_OUTCOMES)
    .refine(hasUniqueRowIds, { message: "Weekly outcome ids must be unique." }),
}).strict();

const monthlyPriority = z.object({
  id: objectId("monthly priority id").optional(),
  title: z.string().trim().min(1).max(240),
  ownerUserId: objectId("priority owner user id").nullable().default(null),
  completed: z.boolean().default(false),
  linkedTaskIds: taskIds.optional(),
}).strict();

export const monthlyPriorityInputSchema = z.object({
  locationId: nullableLocationId,
  priorities: z
    .array(monthlyPriority)
    .max(MAX_MONTHLY_PRIORITIES)
    .refine(hasUniqueRowIds, {
      message: "Monthly priority ids must be unique.",
    }),
}).strict();

export const planningSettingsInputSchema = z.object({
  expectedUpdateTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
}).strict();

export const planningScheduleInputSchema = z.object({
  expectedWeekdays: z
    .array(z.number().int().min(1).max(7))
    .max(7)
    .refine((values) => new Set(values).size === values.length, {
      message: "Expected weekdays must be unique.",
    }),
}).strict();

export const attentionInputSchema = z.object({
  status: z.enum(["acknowledged", "resolved"]),
}).strict();

export type PlanningOverviewQuery = z.infer<typeof planningOverviewQuerySchema>;
export type DailyUpdateInput = z.infer<typeof dailyUpdateInputSchema>;
export type WeeklyPlanInput = z.infer<typeof weeklyPlanInputSchema>;
export type MonthlyPriorityInput = z.infer<typeof monthlyPriorityInputSchema>;
