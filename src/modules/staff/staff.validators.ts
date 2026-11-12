import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_STAFF_COLOR,
  DEFAULT_STAFF_LIMIT,
  EMPLOYMENT_TYPES,
  MAX_STAFF_LIMIT,
  STAFF_ROLES,
  STAFF_TASK_CATEGORIES,
  STAFF_TASK_LINK_TYPES,
  STAFF_TASK_PRIORITIES,
  STAFF_TASK_STATUSES,
} from "./staff.constants.js";

const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const optionalObjectIdSchema = (fieldName = "id") =>
  z
    .union([objectIdSchema(fieldName), z.literal(""), z.null(), z.undefined()])
    .transform((value) => (value ? String(value) : null));

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, "Invalid HEX color.");

export const staffMemberIdParamsSchema = z.object({
  id: objectIdSchema("staff member id"),
});

export const staffTaskIdParamsSchema = z.object({
  id: objectIdSchema("staff task id"),
});

export const listStaffMembersSchema = z.object({
  search: z.string().trim().default(""),
  role: z.enum(STAFF_ROLES).optional(),
  location: objectIdSchema("location id").optional(),
  isActive: z.coerce.boolean().optional(),
  isBookable: z.coerce.boolean().optional(),
  visibleOnWebsite: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_STAFF_LIMIT)
    .default(DEFAULT_STAFF_LIMIT),
});

export const createStaffMemberSchema = z.object({
  user: optionalObjectIdSchema("user id").optional(),
  firstname: z.string().trim().min(1).max(80),
  lastname: z.string().trim().min(1).max(80),
  email: z.email().trim().toLowerCase(),
  phone: z.string().trim().max(40).default(""),
  role: z.enum(STAFF_ROLES).default("instructor"),
  locations: z.array(objectIdSchema("location id")).default([]),
  bio: z.string().trim().max(3000).default(""),
  avatarUrl: z.string().trim().max(1000).default(""),
  color: hexColorSchema.default(DEFAULT_STAFF_COLOR),
  skills: z.array(z.string().trim().min(1)).default([]),
  isBookable: z.coerce.boolean().default(true),
  visibleOnWebsite: z.coerce.boolean().default(true),
  isActive: z.coerce.boolean().default(true),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("employee"),
  hourlyRate: z.coerce.number().min(0).nullable().default(null),
  note: z.string().trim().max(3000).default(""),
});

// Define update fields independently so omitted values remain `undefined`.
// Zod's `.partial()` keeps defaults nested in the create schema and would
// otherwise turn a small patch into a destructive full-field replacement.
export const updateStaffMemberSchema = z.object({
  user: optionalObjectIdSchema("user id").optional(),
  firstname: z.string().trim().min(1).max(80).optional(),
  lastname: z.string().trim().min(1).max(80).optional(),
  email: z.email().trim().toLowerCase().optional(),
  phone: z.string().trim().max(40).optional(),
  role: z.enum(STAFF_ROLES).optional(),
  locations: z.array(objectIdSchema("location id")).optional(),
  bio: z.string().trim().max(3000).optional(),
  avatarUrl: z.string().trim().max(1000).optional(),
  color: hexColorSchema.optional(),
  skills: z.array(z.string().trim().min(1)).optional(),
  isBookable: z.coerce.boolean().optional(),
  visibleOnWebsite: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  hourlyRate: z.coerce.number().min(0).nullable().optional(),
  note: z.string().trim().max(3000).optional(),
});

export const listStaffTasksSchema = z.object({
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  location: z.string().trim().optional(),
  status: z.enum(STAFF_TASK_STATUSES).optional(),
  priority: z.enum(STAFF_TASK_PRIORITIES).optional(),
  assignedTo: objectIdSchema("assigned user id").optional(),
  category: z.enum(STAFF_TASK_CATEGORIES).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_STAFF_LIMIT)
    .default(DEFAULT_STAFF_LIMIT),
});

const staffTaskLinkSchema = z.object({
  type: z.enum(STAFF_TASK_LINK_TYPES),
  resourceId: objectIdSchema("linked resource id"),
  label: z.string().trim().max(180).default(""),
}).strict();

const staffTaskFields = {
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(3000),
  location: optionalObjectIdSchema("location id"),
  locationId: optionalObjectIdSchema("location id"),
  appliesToAllLocations: z.coerce.boolean(),
  assignedTo: optionalObjectIdSchema("assigned user id"),
  dueDate: z.coerce.date().nullable(),
  status: z.enum(STAFF_TASK_STATUSES),
  priority: z.enum(STAFF_TASK_PRIORITIES),
  blockerReason: z.string().trim().max(1000),
  category: z.enum(STAFF_TASK_CATEGORIES),
  links: z.array(staffTaskLinkSchema).max(20),
};

const createStaffTaskBaseSchema = z.object({
  title: staffTaskFields.title,
  description: staffTaskFields.description.default(""),
  location: staffTaskFields.location.default(null),
  locationId: staffTaskFields.locationId.optional(),
  appliesToAllLocations: staffTaskFields.appliesToAllLocations.default(false),
  assignedTo: staffTaskFields.assignedTo.default(null),
  dueDate: staffTaskFields.dueDate.default(null),
  status: staffTaskFields.status.default("todo"),
  priority: staffTaskFields.priority.default("normal"),
  blockerReason: staffTaskFields.blockerReason.default(""),
  category: staffTaskFields.category.default("general"),
  links: staffTaskFields.links.default([]),
});

// Keep update fields genuinely optional. `createSchema.partial()` is unsafe
// here because Zod preserves the inner defaults and would fill omitted fields.
const updateStaffTaskBaseSchema = z.object({
  title: staffTaskFields.title.optional(),
  description: staffTaskFields.description.optional(),
  location: staffTaskFields.location.optional(),
  locationId: staffTaskFields.locationId.optional(),
  appliesToAllLocations: staffTaskFields.appliesToAllLocations.optional(),
  assignedTo: staffTaskFields.assignedTo.optional(),
  dueDate: staffTaskFields.dueDate.optional(),
  status: staffTaskFields.status.optional(),
  priority: staffTaskFields.priority.optional(),
  blockerReason: staffTaskFields.blockerReason.optional(),
  category: staffTaskFields.category.optional(),
  links: staffTaskFields.links.optional(),
});

const validateStaffTaskLocation = (
  value: {
    appliesToAllLocations?: boolean;
    location?: string | null;
    locationId?: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  if (
    value.location &&
    value.locationId &&
    value.location !== value.locationId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["locationId"],
      message: "location and locationId must refer to the same location.",
    });
  }
};

export const createStaffTaskSchema =
  createStaffTaskBaseSchema.superRefine(validateStaffTaskLocation);

export const updateStaffTaskSchema = updateStaffTaskBaseSchema
  .superRefine(validateStaffTaskLocation);

export type ListStaffMembersInput = z.infer<typeof listStaffMembersSchema>;
export type CreateStaffMemberInput = z.infer<typeof createStaffMemberSchema>;
export type UpdateStaffMemberInput = z.infer<typeof updateStaffMemberSchema>;
export type ListStaffTasksInput = z.infer<typeof listStaffTasksSchema>;
export type CreateStaffTaskInput = z.infer<typeof createStaffTaskSchema>;
export type UpdateStaffTaskInput = z.infer<typeof updateStaffTaskSchema>;
