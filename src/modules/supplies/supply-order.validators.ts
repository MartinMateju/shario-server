import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_SUPPLY_ORDER_LIMIT,
  DEFAULT_SUPPLY_ORDER_PAGE,
  EMAIL_REGEX,
  MAX_SUPPLY_ORDER_LIMIT,
  SORT_DIRECTION,
  SUPPLY_ORDER_PRIORITY,
  SUPPLY_ORDER_SORT_FIELD,
  SUPPLY_ORDER_STATUS,
} from "./supply-order.constants.js";

export const objectIdSchema = (fieldName = "id") =>
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

const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => !value || EMAIL_REGEX.test(value), {
    message: "Invalid email address.",
  })
  .default("");

export const supplyOrderStatusSchema = z.enum(
  Object.values(SUPPLY_ORDER_STATUS) as [string, ...string[]],
);

export const supplyOrderPrioritySchema = z.enum(
  Object.values(SUPPLY_ORDER_PRIORITY) as [string, ...string[]],
);

export const createSupplyOrderSchema = z.object({
  title: z.string().trim().min(1).max(180),
  location: optionalObjectIdSchema("location"),
  customerName: z.string().trim().min(1).max(180),
  customerEmail: optionalEmailSchema,
  customerPhone: z.string().trim().max(60).default(""),
  assignedTo: optionalObjectIdSchema("assignedTo"),
  registeredAt: z.coerce.date().optional(),
  deadline: z.coerce.date().nullable().optional(),
  status: supplyOrderStatusSchema.default(SUPPLY_ORDER_STATUS.NEW),
  priority: supplyOrderPrioritySchema.default(SUPPLY_ORDER_PRIORITY.NORMAL),
  price: z.coerce.number().min(0).default(0),
  depositPaid: z.coerce.number().min(0).default(0),
  units: z.coerce.number().int().min(1).default(1),
  unitLabel: z.string().trim().max(40).default("ks"),
  publicNote: z.string().trim().max(4000).default(""),
  internalNote: z.string().trim().max(4000).default(""),
  requestedByUser: optionalObjectIdSchema("requestedByUser"),
});

export const updateSupplyOrderSchema = createSupplyOrderSchema.partial();

export const supplyOrderIdParamsSchema = z.object({
  id: objectIdSchema("supply order id"),
});

export const listSupplyOrdersSchema = z.object({
  status: z.union([supplyOrderStatusSchema, z.literal("all")]).optional(),
  priority: z.union([supplyOrderPrioritySchema, z.literal("all")]).optional(),
  location: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  search: z.string().trim().default(""),
  page: z.coerce.number().int().positive().default(DEFAULT_SUPPLY_ORDER_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_SUPPLY_ORDER_LIMIT)
    .default(DEFAULT_SUPPLY_ORDER_LIMIT),
  sortBy: z
    .enum(Object.values(SUPPLY_ORDER_SORT_FIELD) as [string, ...string[]])
    .default(SUPPLY_ORDER_SORT_FIELD.CREATED_AT),
  sortDirection: z
    .enum(Object.values(SORT_DIRECTION) as [string, ...string[]])
    .default(SORT_DIRECTION.DESC),
});

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1).max(180),
  ico: z.string().trim().max(40).default(""),
  dic: z.string().trim().max(40).default(""),
  contactPerson: z.string().trim().max(180).default(""),
  email: optionalEmailSchema,
  phone: z.string().trim().max(60).default(""),
  address: z.string().trim().max(1000).default(""),
  note: z.string().trim().max(4000).default(""),
  isActive: z.coerce.boolean().default(true),
});

export const updateSupplierSchema = createSupplierSchema.partial();

export const supplierIdParamsSchema = z.object({
  id: objectIdSchema("supplier id"),
});

export const listSuppliersSchema = z.object({
  search: z.string().trim().default(""),
  isActive: z
    .union([z.coerce.boolean(), z.literal("all")])
    .optional(),
});

export type CreateSupplyOrderInput = z.infer<typeof createSupplyOrderSchema>;
export type UpdateSupplyOrderInput = z.infer<typeof updateSupplyOrderSchema>;
export type ListSupplyOrdersInput = z.infer<typeof listSupplyOrdersSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersInput = z.infer<typeof listSuppliersSchema>;
