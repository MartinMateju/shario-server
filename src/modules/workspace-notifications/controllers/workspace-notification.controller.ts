import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { workspaceNotificationService } from "../services/workspace-notification.service.js";
import type { WorkspaceNotificationVisibility } from "../workspace-notification.types.js";
import {
  listWorkspaceNotificationsSchema,
  parseWorkspaceNotificationInput,
  readAllWorkspaceNotificationsSchema,
  workspaceNotificationIdParamsSchema,
  workspaceNotificationSummarySchema,
} from "../workspace-notification.validators.js";

const buildVisibility = (req: Request): WorkspaceNotificationVisibility => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);

  return {
    tenantId: requireTenantId(req),
    recipientUserId: getAuthenticatedUserId(req),
    allowedLocationIds: getAllowedWorkspaceLocationIds(access),
    permissions: access.permissions,
  };
};

const send = (res: Response, data: unknown): void => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json(data);
};

export const listWorkspaceNotifications = asyncHandler(async (req, res) => {
  const input = parseWorkspaceNotificationInput(
    listWorkspaceNotificationsSchema,
    req.query,
  );
  send(
    res,
    await workspaceNotificationService.list({
      ...buildVisibility(req),
      ...input,
    }),
  );
});

export const getWorkspaceNotificationSummary = asyncHandler(
  async (req, res) => {
    const input = parseWorkspaceNotificationInput(
      workspaceNotificationSummarySchema,
      req.query,
    );
    send(
      res,
      await workspaceNotificationService.summary(
        buildVisibility(req),
        input.locationId,
      ),
    );
  },
);

export const markWorkspaceNotificationRead = asyncHandler(async (req, res) => {
  const { id } = parseWorkspaceNotificationInput(
    workspaceNotificationIdParamsSchema,
    req.params,
  );
  send(
    res,
    await workspaceNotificationService.markRead(buildVisibility(req), id),
  );
});

export const markAllWorkspaceNotificationsRead = asyncHandler(
  async (req, res) => {
    const input = parseWorkspaceNotificationInput(
      readAllWorkspaceNotificationsSchema,
      req.body,
    );
    send(
      res,
      await workspaceNotificationService.markAllRead({
        ...buildVisibility(req),
        ...input,
      }),
    );
  },
);
