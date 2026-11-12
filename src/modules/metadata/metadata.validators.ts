import mongoose from "mongoose";
import { z } from "zod";

import { METADATA_TAGS } from "./metadata.constants.js";

const objectIdSchema = (fieldName: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

const optionalObjectIdSchema = (fieldName: string) =>
  z
    .string()
    .trim()
    .optional()
    .nullable()
    .refine(
      (value) => !value || mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

export const metadataTagSchema = z.enum(
  METADATA_TAGS as [string, ...string[]],
);

export const createMetadataSchema = z.object({
  createdBy: objectIdSchema("createdBy"),
  order: optionalObjectIdSchema("order"),
  product: optionalObjectIdSchema("product"),
  booking: optionalObjectIdSchema("booking"),
  quantity: z.coerce.number().int().positive(),
  tag: metadataTagSchema.optional(),
});

export const createMetadataManySchema = z.object({
  items: z.array(createMetadataSchema).min(1),
});

export const listMetadataSchema = z.object({
  createdBy: optionalObjectIdSchema("createdBy"),
  order: optionalObjectIdSchema("order"),
  product: optionalObjectIdSchema("product"),
  booking: optionalObjectIdSchema("booking"),
  tag: metadataTagSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export type CreateMetadataDto = z.infer<typeof createMetadataSchema>;
export type CreateMetadataManyDto = z.infer<typeof createMetadataManySchema>;
export type ListMetadataDto = z.infer<typeof listMetadataSchema>;
