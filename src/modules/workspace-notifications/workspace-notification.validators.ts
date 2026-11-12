import mongoose from "mongoose";
import { z } from "zod";

import { badRequest } from "@/shared/http/httpErrors.js";

import {
  DEFAULT_WORKSPACE_NOTIFICATION_PAGE_SIZE,
  MAX_WORKSPACE_NOTIFICATION_PAGE_SIZE,
  WORKSPACE_NOTIFICATION_CATEGORIES,
  WORKSPACE_NOTIFICATION_STATUSES,
  WORKSPACE_NOTIFICATION_STATUS,
  type WorkspaceNotificationCategory,
  type WorkspaceNotificationStatus,
} from "./workspace-notification.constants.js";
export { isSafeWorkspaceNotificationActionUrl } from "./workspace-notification.utils.js";

const objectIdSchema = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${label}.`,
    });

export const listWorkspaceNotificationsSchema = z
  .object({
    category: z
      .enum(WORKSPACE_NOTIFICATION_CATEGORIES as [
        WorkspaceNotificationCategory,
        ...WorkspaceNotificationCategory[],
      ])
      .optional(),
    locationId: objectIdSchema("location id").optional(),
    status: z
      .enum(WORKSPACE_NOTIFICATION_STATUSES as [
        WorkspaceNotificationStatus,
        ...WorkspaceNotificationStatus[],
      ])
      .default(WORKSPACE_NOTIFICATION_STATUS.ALL),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_WORKSPACE_NOTIFICATION_PAGE_SIZE)
      .default(DEFAULT_WORKSPACE_NOTIFICATION_PAGE_SIZE),
  })
  .strict();

export const workspaceNotificationSummarySchema = z
  .object({
    locationId: objectIdSchema("location id").optional(),
  })
  .strict();

export const workspaceNotificationIdParamsSchema = z
  .object({
    id: objectIdSchema("workspace notification id"),
  })
  .strict();

export const readAllWorkspaceNotificationsSchema = z
  .object({
    category: z
      .enum(WORKSPACE_NOTIFICATION_CATEGORIES as [
        WorkspaceNotificationCategory,
        ...WorkspaceNotificationCategory[],
      ])
      .optional(),
    locationId: objectIdSchema("location id").optional(),
  })
  .strict();

export type ListWorkspaceNotificationsInput = z.infer<
  typeof listWorkspaceNotificationsSchema
>;
export type WorkspaceNotificationSummaryInput = z.infer<
  typeof workspaceNotificationSummarySchema
>;
export type ReadAllWorkspaceNotificationsInput = z.infer<
  typeof readAllWorkspaceNotificationsSchema
>;

export const parseWorkspaceNotificationInput = <T>(
  schema: z.ZodType<T>,
  input: unknown,
): T => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    badRequest({
      message: "Invalid workspace notification request.",
      code: "WORKSPACE_NOTIFICATION_VALIDATION_FAILED",
      details: parsed.error.flatten(),
    });
  }

  return parsed.data;
};
