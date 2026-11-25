import mongoose from "mongoose";
import { z } from "zod";
import { badRequest } from "@/shared/http/httpErrors.js";

const amount = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+)?$/)
      .transform(Number),
  ])
  .pipe(z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER))
  .optional();
const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
  .optional();
const date = z.iso.date().optional();
export const reportCustomerQuerySchema = z
  .object({
    from: date,
    to: date,
    spendFrom: date,
    spendTo: date,
    cancellationFrom: date,
    cancellationTo: date,
    locationId: z.string().refine(mongoose.isValidObjectId).optional(),
    locale: z.string().max(35).optional(),
    search: z.string().trim().max(160).default(""),
    spendMin: amount,
    spendMax: amount,
    creditMin: amount,
    creditMax: amount,
    cancelledMin: count,
    cancelledMax: count,
    cancellationActor: z.enum(["all", "customer", "staff"]).default("all"),
    inactiveDays: z.coerce.number().int().min(1).max(3650).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [minimum, maximum] of [
      ["spendMin", "spendMax"],
      ["creditMin", "creditMax"],
      ["cancelledMin", "cancelledMax"],
      ["from", "to"],
      ["spendFrom", "spendTo"],
      ["cancellationFrom", "cancellationTo"],
    ] as const) {
      if (
        value[minimum] !== undefined &&
        value[maximum] !== undefined &&
        value[minimum]! > value[maximum]!
      )
        ctx.addIssue({
          code: "custom",
          message: "Minimum must not exceed maximum.",
          path: [minimum],
        });
    }
  });
export type ReportCustomerQuery = z.infer<typeof reportCustomerQuerySchema>;
export const parseReportCustomerQuery = (
  input: unknown,
): ReportCustomerQuery => {
  const result = reportCustomerQuerySchema.safeParse(input);
  if (!result.success)
    badRequest({
      code: "REPORT_CUSTOMER_FILTERS_INVALID",
      message: "Invalid customer report filters.",
      details: result.error.flatten(),
    });
  return result.data;
};
