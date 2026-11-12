import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_EVENT_LIMIT,
  DEFAULT_EVENT_PAGE,
  EVENT_STATUSES,
  EVENT_TYPES,
  MAX_EVENT_LIMIT,
  TIME_REGEX,
} from "./event.constants.js";

const objectIdSchema = (fieldName: string) =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const optionalObjectIdSchema = (fieldName: string) =>
  z
    .union([objectIdSchema(fieldName), z.literal(""), z.null(), z.undefined()])
    .transform((value) => (value ? String(value) : null));

const optionalTimeSchema = z
  .string()
  .trim()
  .refine((value) => !value || TIME_REGEX.test(value), {
    message: "Time must be in HH:mm format.",
  })
  .default("");

const eventChecklistItemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  done: z.coerce.boolean().default(false),
});

const eventShape = {
  title: z.string().trim().min(1).max(160),
  type: z.enum(EVENT_TYPES).default("other"),
  status: z.enum(EVENT_STATUSES).default("inquiry"),
  location: optionalObjectIdSchema("location id"),
  externalLocationName: z.string().trim().max(200).default(""),
  date: z.coerce.date(),
  startTime: optionalTimeSchema,
  endTime: optionalTimeSchema,
  customerName: z.string().trim().max(160).default(""),
  contactPerson: z.string().trim().max(160).default(""),
  email: z.union([z.string().trim().email().toLowerCase(), z.literal("")]).default(""),
  phone: z.string().trim().max(40).default(""),
  numberOfGuests: z.coerce.number().int().min(1).default(1),
  priceEstimate: z.coerce.number().min(0).default(0),
  finalPrice: z.coerce.number().min(0).default(0),
  depositPaid: z.coerce.number().min(0).default(0),
  assignedStaff: z.array(objectIdSchema("staff id")).default([]),
  order: optionalObjectIdSchema("order id"),
  bookings: z.array(objectIdSchema("booking id")).default([]),
  notes: z.string().trim().max(5000).default(""),
  internalNotes: z.string().trim().max(5000).default(""),
  checklist: z.array(eventChecklistItemSchema).default([]),
};

const validateEventFields = (
  value: {
    startTime?: string;
    endTime?: string;
    depositPaid?: number;
    finalPrice?: number;
  },
  ctx: z.RefinementCtx,
) => {
  if (value.startTime && value.endTime && value.startTime >= value.endTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endTime"],
      message: "End time must be later than start time.",
    });
  }

  if (
    typeof value.depositPaid === "number" &&
    typeof value.finalPrice === "number" &&
    value.depositPaid > value.finalPrice &&
    value.finalPrice > 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["depositPaid"],
      message: "Deposit paid cannot be greater than final price.",
    });
  }
};

const baseEventSchema = z.object(eventShape);

export const createEventSchema = baseEventSchema.superRefine(validateEventFields);

export const updateEventSchema = z
  .object({
    ...eventShape,
    id: objectIdSchema("event id"),
  })
  .partial()
  .extend({
    id: objectIdSchema("event id"),
  })
  .superRefine(validateEventFields);

export const eventIdParamsSchema = z.object({
  id: objectIdSchema("event id"),
});

export const listEventsSchema = z.object({
  status: z.enum(EVENT_STATUSES).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  location: objectIdSchema("location id").optional(),
  search: z.string().trim().default(""),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(DEFAULT_EVENT_PAGE),
  limit: z.coerce.number().int().positive().max(MAX_EVENT_LIMIT).default(DEFAULT_EVENT_LIMIT),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type ListEventsInput = z.infer<typeof listEventsSchema>;