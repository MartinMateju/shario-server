import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { sendAccessCodeNotifications } from "../services/access-code-notification.service.js";
import { sendUpcomingCourseReminders } from "../services/access-code-reminder.service.js";
import { markProcessedBookingsAsDelivered } from "@/modules/booking/services/booking.status.service.js";

export const runAccessCodeNotifications = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    const result = await sendAccessCodeNotifications();
    res.json(result);
  },
);

export const runCourseReminders = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    const sentCount = await sendUpcomingCourseReminders();
    res.json({ sentCount });
  },
);

export const runBookingDeliveryUpdate = asyncHandler(
  async (_req: Request, res: Response): Promise<void> => {
    const modifiedCount = await markProcessedBookingsAsDelivered();
    res.json({ modifiedCount });
  },
);
