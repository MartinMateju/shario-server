import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";

import {
  getCustomerNotificationSummary,
  listCustomerNotifications,
  markAllCustomerNotificationsRead,
  markCustomerNotificationRead,
} from "../controllers/customer-notification.controller.js";

export const customerNotificationRouter = Router();

customerNotificationRouter.use(verifyJWT);
customerNotificationRouter.use(requireCustomerSession);

customerNotificationRouter.get("/", listCustomerNotifications);
customerNotificationRouter.get("/summary", getCustomerNotificationSummary);
customerNotificationRouter.post("/read-all", markAllCustomerNotificationsRead);
customerNotificationRouter.patch("/:id/read", markCustomerNotificationRead);

export default customerNotificationRouter;
