import mongoose from "mongoose";
import { z } from "zod";

const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const optionalBooleanFromQuerySchema = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  })
  .optional();

export const registeredSenderEmailIdParamsSchema = z.object({
  id: objectIdSchema("sender email id"),
});

export const listRegisteredSenderEmailsSchema = z.object({
  search: z.string().trim().default(""),
  isActive: optionalBooleanFromQuerySchema,
});

export const createRegisteredSenderEmailSchema = z
  .object({
    replyToEmail: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().default(""),
    note: z.string().trim().default(""),
    isDefault: z.coerce.boolean().default(false),
  })
  .strict();

export const updateRegisteredSenderEmailSchema =
  createRegisteredSenderEmailSchema.partial().strict();

export const confirmReplyToVerificationSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter the six-digit code."),
  })
  .strict();

export type ListRegisteredSenderEmailsInput = z.infer<
  typeof listRegisteredSenderEmailsSchema
>;
export type CreateRegisteredSenderEmailInput = z.infer<
  typeof createRegisteredSenderEmailSchema
>;
export type UpdateRegisteredSenderEmailInput = z.infer<
  typeof updateRegisteredSenderEmailSchema
>;
export type ConfirmReplyToVerificationInput = z.infer<
  typeof confirmReplyToVerificationSchema
>;
