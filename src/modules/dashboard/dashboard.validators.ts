import mongoose from "mongoose";
import { z } from "zod";

const calendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

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

