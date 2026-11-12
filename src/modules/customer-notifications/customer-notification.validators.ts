import mongoose from "mongoose";
import { z } from "zod";

import { badRequest } from "@/shared/http/httpErrors.js";

import {
  CUSTOMER_NOTIFICATION_CATEGORIES,
  CUSTOMER_NOTIFICATION_STATUSES,
  CUSTOMER_NOTIFICATION_STATUS,
  DEFAULT_CUSTOMER_NOTIFICATION_PAGE_SIZE,
  MAX_CUSTOMER_NOTIFICATION_PAGE_SIZE,
  type CustomerNotificationCategory,
  type CustomerNotificationStatus,
} from "./customer-notification.constants.js";
export { isSafeCustomerNotificationActionUrl } from "./customer-notification.utils.js";

const objectIdSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${label}.`,
    });

export const listCustomerNotificationsSchema = z
  .object({
    category: z
      .enum(
        CUSTOMER_NOTIFICATION_CATEGORIES as [
          CustomerNotificationCategory,
          ...CustomerNotificationCategory[],
        ],
      )
      .optional(),
    status: z
      .enum(
        CUSTOMER_NOTIFICATION_STATUSES as [
          CustomerNotificationStatus,
          ...CustomerNotificationStatus[],
        ],
      )
      .default(CUSTOMER_NOTIFICATION_STATUS.ALL),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_CUSTOMER_NOTIFICATION_PAGE_SIZE)
      .default(DEFAULT_CUSTOMER_NOTIFICATION_PAGE_SIZE),
  })
  .strict();

export const customerNotificationIdParamsSchema = z
  .object({
    id: objectIdSchema("customer notification id"),
  })
  .strict();

export const customerNotificationSummarySchema = z.object({}).strict();

export const readAllCustomerNotificationsSchema = z
  .object({
    category: z
      .enum(
        CUSTOMER_NOTIFICATION_CATEGORIES as [
          CustomerNotificationCategory,
          ...CustomerNotificationCategory[],
        ],
      )
      .optional(),
  })
  .strict();

export const parseCustomerNotificationInput = <T>(
  schema: z.ZodType<T>,
  input: unknown,
): T => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    badRequest({
      message: "Invalid customer notification request.",
      code: "CUSTOMER_NOTIFICATION_VALIDATION_FAILED",
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
};
