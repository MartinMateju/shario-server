import mongoose from "mongoose";
import { z } from "zod";

import {
  COMMUNICATION_EMAIL_LOG_STATUS_VALUES,
  COMMUNICATION_EMAIL_TYPE_VALUES,
  DEFAULT_EMAIL_LOG_LIMIT,
  DEFAULT_EMAIL_LOG_PAGE,
  MAX_EMAIL_LOG_LIMIT,
} from "./communication-email-log.constants.js";

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

export const listCommunicationEmailLogsSchema = z.object({
  status: z
    .union([z.enum(COMMUNICATION_EMAIL_LOG_STATUS_VALUES), z.literal("all")])
    .default("all"),

  emailType: z
    .union([z.enum(COMMUNICATION_EMAIL_TYPE_VALUES), z.literal("all")])
    .default("all"),

  search: z.string().trim().default(""),

  automationId: z.string().trim().optional(),
  userId: z.string().trim().optional(),
  recipientEmail: z.string().trim().toLowerCase().optional(),
  relatedEntityId: z.string().trim().optional(),
  firingId: objectIdSchema("firing id").optional(),

  page: z.coerce.number().int().positive().default(DEFAULT_EMAIL_LOG_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_EMAIL_LOG_LIMIT)
    .default(DEFAULT_EMAIL_LOG_LIMIT),
});

export const communicationEmailLogIdParamsSchema = z.object({
  id: objectIdSchema("email log id"),
});

export type ListCommunicationEmailLogsInput = z.infer<
  typeof listCommunicationEmailLogsSchema
>;

export type CommunicationEmailLogIdParams = z.infer<
  typeof communicationEmailLogIdParamsSchema
>;
