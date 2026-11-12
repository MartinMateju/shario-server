import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  createEmailNotificationSchema,
  idParamsSchema,
  listEmailNotificationsSchema,
  listNotificationLogsSchema,
} from "@/modules/notification/notification.validators.js";
import { notificationService } from "@/modules/notification/services/notification.service.js";

const getCurrentUserId = (req: Request): string => {
  const userInfo = (req as Request & { userInfo?: { id?: string } }).userInfo;

  if (!userInfo?.id) {
    badRequest("Authenticated user is missing from request.");
  }

  return userInfo.id;
};

export const getNotificationLogs = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listNotificationLogsSchema.parse(req.query);

    const result = await notificationService.listLogs({
      tenantId,
      ...input,
    });

    res.json(result);
  },
);

export const getEmailNotifications = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listEmailNotificationsSchema.parse(req.query);

    const result = await notificationService.listEmailNotifications({
      tenantId,
      ...input,
    });

    res.json(result);
  },
);

export const getEmailNotificationById = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = idParamsSchema.parse(req.params);

    const notification = await notificationService.getEmailNotificationById(
      tenantId,
      id,
    );

    if (!notification) {
      notFound("Email notification was not found.");
    }

    res.json(notification);
  },
);

export const createEmailNotification = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const sentBy = getCurrentUserId(req);
    const input = createEmailNotificationSchema.parse(req.body);

    const notification = await notificationService.createEmailNotification(
      tenantId,
      sentBy,
      input,
    );

    res.status(201).json(notification);
  },
);
