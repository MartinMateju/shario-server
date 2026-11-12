import mongoose from "mongoose";
import { z } from "zod";

import { REPORT_GRANULARITY } from "./reports.types.js";

const calendarDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const objectIdSchema = z
  .string()
  .trim()
  .refine((value) => mongoose.isValidObjectId(value), {
    message: "Invalid location id.",
  });

const queryBoolean = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return value;
}, z.boolean());

export const reportQuerySchema = z
  .object({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    locationId: objectIdSchema.optional(),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .refine((value) => {
        try {
          return Intl.getCanonicalLocales(value).length === 1;
        } catch {
          return false;
        }
      }, "Use a valid report locale.")
      .optional(),
    compare: queryBoolean.default(false),
    granularity: z
      .enum(Object.values(REPORT_GRANULARITY))
      .default(REPORT_GRANULARITY.AUTO),
  })
  .strict();

export type ParsedReportQuery = z.infer<typeof reportQuerySchema>;
