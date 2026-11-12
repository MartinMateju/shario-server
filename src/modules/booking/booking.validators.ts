import mongoose from "mongoose";
import { z } from "zod";

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}`,
    );

export const bookingLocationSchema = objectIdSchema("location id");

export const nonEmptyArraySchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
  fieldName: string,
) => z.array(itemSchema).min(1, `${fieldName} is required`);
