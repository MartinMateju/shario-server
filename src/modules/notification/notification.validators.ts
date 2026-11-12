import mongoose from "mongoose";
import { z } from "zod";

import {
  BULK_NOTIFICATION_LIMITS,
  DEFAULT_NOTIFICATION_LIMIT,
  DEFAULT_NOTIFICATION_PAGE,
  EMAIL_NOTIFICATION_TYPE,
  MAX_NOTIFICATION_LIMIT,
  NOTIFICATION_STATUS,
} from "./notification.constants.js";

const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine(
      (value) => mongoose.Types.ObjectId.isValid(value),
      `Invalid ${fieldName}.`,
    );

const optionalDateSchema = z
  .union([z.string(), z.date()])
  .optional()
  .transform((value) => {
    if (!value) return undefined;

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  });

export const listNotificationLogsSchema = z.object({
  status: z
    .enum(Object.values(NOTIFICATION_STATUS) as [string, ...string[]])
    .optional(),
  type: z.string().trim().optional(),
  recipient: z.string().trim().toLowerCase().optional(),
  page: z.coerce.number().int().positive().default(DEFAULT_NOTIFICATION_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_NOTIFICATION_LIMIT)
    .default(DEFAULT_NOTIFICATION_LIMIT),
});

export const listEmailNotificationsSchema = z.object({
  emailType: z.string().trim().optional(),
  sentFrom: optionalDateSchema,
  sentTo: optionalDateSchema,
  page: z.coerce.number().int().positive().default(DEFAULT_NOTIFICATION_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_NOTIFICATION_LIMIT)
    .default(DEFAULT_NOTIFICATION_LIMIT),
});

export const emailNotificationRecipientSchema = z.object({
  user: objectIdSchema("user id").optional().nullable(),
  userCustomId: z.string().trim().max(100).default(""),
  firstname: z.string().trim().max(100).default(""),
  lastname: z.string().trim().max(100).default(""),
  email: z.email().trim().toLowerCase(),
  privateMessage: z.string().trim().max(2_000).default(""),
  photoUrl: z.string().trim().max(2_048).default(""),
  itemCount: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(10_000)
    .nullable()
    .optional(),
  recipientIndex: z.coerce.number().int().nonnegative().max(99_999).optional(),
  imageCount: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(BULK_NOTIFICATION_LIMITS.MAX_FILES)
    .default(0),
});

export const createEmailNotificationSchema = z.object({
  title: z.string().trim().default("Hromadný e-mail"),
  emailType: z.string().trim().min(1, "Email type is required."),
  subject: z.string().trim().default(""),
  globalMessage: z.string().trim().default(""),
  relatedBooking: objectIdSchema("related booking id").optional().nullable(),
  recipients: z
    .array(emailNotificationRecipientSchema)
    .min(1, "At least one recipient is required."),
});

export const idParamsSchema = z.object({
  id: objectIdSchema("notification id"),
});

export type ListNotificationLogsInput = z.infer<
  typeof listNotificationLogsSchema
>;

export type ListEmailNotificationsInput = z.infer<
  typeof listEmailNotificationsSchema
>;

export type CreateEmailNotificationInput = z.infer<
  typeof createEmailNotificationSchema
>;
