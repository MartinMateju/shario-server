import { z } from "zod";
import {
  STUDIO_COMMERCE_CURRENCIES,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";

export const customOrderId = z.string().regex(/^[a-f\d]{24}$/i);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.getUTCFullYear() >= 1 &&
      parsed.getUTCFullYear() <= 9998 &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Enter a valid calendar date.");
const contact = z
  .object({
    name: z.string().trim().max(160).default(""),
    email: z
      .union([z.literal(""), z.string().trim().email().max(254)])
      .default(""),
    phone: z.string().trim().max(40).default(""),
  })
  .strict()
  .refine(
    (value) => (!value.email && !value.phone) || Boolean(value.name),
    "Enter a customer name.",
  );
const fields = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(10000),
    materials: z.string().trim().min(1).max(4000),
    finish: z.string().trim().max(4000).default(""),
    pieceCount: z.number().int().min(1).max(1000000),
    startDate: date,
    deadline: date,
    locationId: customOrderId,
    customerId: customOrderId.nullable().default(null),
    customer: contact.default({ name: "", email: "", phone: "" }),
    assigneeId: customOrderId.nullable().default(null),
    quotedAmount: z
      .number()
      .finite()
      .min(0)
      .max(100000000)
      .nullable()
      .default(null),
    currency: z.enum(STUDIO_COMMERCE_CURRENCIES),
  })
  .strict();
const validateFields = (
  value: z.infer<typeof fields>,
  ctx: z.RefinementCtx,
) => {
  if (value.deadline < value.startDate)
    ctx.addIssue({
      code: "custom",
      path: ["deadline"],
      message: "Deadline must be on or after the start date.",
    });
  if (value.quotedAmount !== null) {
    try {
      toCurrencyMinorUnits(value.quotedAmount, value.currency);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["quotedAmount"],
        message: "Enter an amount supported by this currency.",
      });
    }
  }
};
export const createCustomOrderInput = fields.superRefine(validateFields);
export const updateCustomOrderInput = fields
  .extend({ revision: z.number().int().min(0) })
  .superRefine(validateFields);
export const customOrderRevision = z
  .object({ revision: z.coerce.number().int().min(0) })
  .strict();
export const customOrderCommentInput = z
  .object({
    revision: z.number().int().min(0),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export const closeCustomOrderInput = z
  .object({
    revision: z.number().int().min(0),
    reason: z.enum(["completed", "cancelled"]),
    note: z.string().trim().max(4000).default(""),
  })
  .strict();
export const reopenCustomOrderInput = z
  .object({
    revision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
export const listCustomOrdersInput = z
  .object({
    locationId: customOrderId.optional(),
    status: z.enum(["all", "active", "overdue", "closed"]).default("all"),
    search: z.string().trim().max(160).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .strict();
export type CreateCustomOrderInput = z.infer<typeof createCustomOrderInput>;
