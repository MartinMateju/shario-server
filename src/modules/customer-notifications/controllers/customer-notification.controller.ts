import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { customerNotificationService } from "../services/customer-notification.service.js";
import type { CustomerNotificationVisibility } from "../customer-notification.types.js";
import {
  customerNotificationIdParamsSchema,
  customerNotificationSummarySchema,
  listCustomerNotificationsSchema,
  parseCustomerNotificationInput,
  readAllCustomerNotificationsSchema,
} from "../customer-notification.validators.js";

/** Tenant and recipient are exclusively derived from the verified token. */
const buildVisibility = (req: Request): CustomerNotificationVisibility => ({
  tenantId: requireTenantId(req),
  recipientUserId: getAuthenticatedUserId(req),
});

const send = (res: Response, data: unknown): void => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).json(data);
};

export const listCustomerNotifications = asyncHandler(async (req, res) => {
  const input = parseCustomerNotificationInput(
    listCustomerNotificationsSchema,
    req.query,
  );
  send(
    res,
    await customerNotificationService.list({
      ...buildVisibility(req),
      ...input,
    }),
  );
});

export const getCustomerNotificationSummary = asyncHandler(async (req, res) => {
  parseCustomerNotificationInput(customerNotificationSummarySchema, req.query);
  send(res, await customerNotificationService.summary(buildVisibility(req)));
});

export const markCustomerNotificationRead = asyncHandler(async (req, res) => {
  const { id } = parseCustomerNotificationInput(
    customerNotificationIdParamsSchema,
    req.params,
  );
  send(
    res,
    await customerNotificationService.markRead(buildVisibility(req), id),
  );
});

export const markAllCustomerNotificationsRead = asyncHandler(
  async (req, res) => {
    const input = parseCustomerNotificationInput(
      readAllCustomerNotificationsSchema,
      req.body ?? {},
    );
    send(
      res,
      await customerNotificationService.markAllRead({
        ...buildVisibility(req),
        ...input,
      }),
    );
  },
);
