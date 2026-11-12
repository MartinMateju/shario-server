import mongoose from "mongoose";
import { z } from "zod";

import { PRODUCT_TYPE } from "@/modules/product/product.constants.js";

import {
  DEFAULT_ORDER_LIMIT,
  DEFAULT_ORDER_PAGE,
  MAX_ORDER_LIMIT,
  ORDER_SORT_FIELD,
  ORDER_SORT_ORDER,
  ORDER_STATUS,
} from "./order.constants.js";

const enumValues = <T extends Record<string, string>>(values: T) =>
  Object.values(values) as [T[keyof T], ...T[keyof T][]];

const optionalEnumFromEmptyString = <T extends Record<string, string>>(values: T) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;

      const trimmed = value.trim();

      return trimmed === "" ? undefined : trimmed;
    },
    z.enum(enumValues(values)).optional(),
  );

const orderEndDateSchema = z.preprocess((value) => {
  // Legacy date-only filters include the whole server-local day. Explicit
  // timestamps (including already parsed Dates) keep the caller's boundary.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value;
  }

  const date = new Date(value.trim());
  date.setHours(23, 59, 59, 999);
  return date;
}, z.coerce.date().optional());

export const orderFilterSchema = z.object({
  search: z.string().trim().default(""),

  dateFrom: z.coerce.date().optional(),

  dateTo: orderEndDateSchema,

  userCustomId: z.string().trim().default(""),

  userEmail: z.string().trim().toLowerCase().default(""),

  productType: optionalEnumFromEmptyString(PRODUCT_TYPE),

  status: optionalEnumFromEmptyString(ORDER_STATUS),

  locationId: z
    .preprocess(
      (value) => (typeof value === "string" && !value.trim() ? undefined : value),
      z.string().trim().refine(mongoose.isValidObjectId).optional(),
    ),

  page: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ORDER_PAGE),

  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ORDER_LIMIT)
    .default(DEFAULT_ORDER_LIMIT),

  sortBy: z
    .enum(enumValues(ORDER_SORT_FIELD))
    .default(ORDER_SORT_FIELD.CREATED_AT),

  sortOrder: z
    .enum(enumValues(ORDER_SORT_ORDER))
    .default(ORDER_SORT_ORDER.DESC),
}).refine(
  ({ dateFrom, dateTo }) => !dateFrom || !dateTo || dateFrom <= dateTo,
  {
    path: ["dateTo"],
    message: "Order end date must not be before its start date.",
  },
);

export type OrderFilterInput = z.infer<typeof orderFilterSchema>;

export const parseOrderFilter = (input: unknown): OrderFilterInput => {
  return orderFilterSchema.parse(input);
};

export const isValidObjectId = (value: string): boolean => {
  return mongoose.isValidObjectId(value);
};
