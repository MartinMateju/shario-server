import mongoose from "mongoose";
import { z } from "zod";

const calendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Use a valid calendar date.");

const locationIdSchema = z
  .string()
  .trim()
  .refine((value) => mongoose.isValidObjectId(value), {
    message: "Invalid location id.",
  });

export const dashboardOverviewQuerySchema = z
  .object({
    date: calendarDateSchema.optional(),
    locationId: locationIdSchema.optional(),
  })
  .strict();

export type ParsedDashboardOverviewQuery = z.infer<
  typeof dashboardOverviewQuerySchema
>;

export const dashboardReportBodySchema = dashboardOverviewQuerySchema
  .extend({
    locale: z.string().trim().min(2).max(20).optional(),
  })
  .strict();

export const dashboardReportIdSchema = z
  .string()
  .refine((value) => mongoose.isValidObjectId(value), {
    message: "Invalid report id.",
  });
