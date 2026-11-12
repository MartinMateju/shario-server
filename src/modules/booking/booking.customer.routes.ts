import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireTenantSubscriptionAccess } from "@/modules/tenant-subscription/middleware/requireTenantSubscriptionAccess.js";

import {
  cancelCustomerBooking,
  getCustomerBooking,
  getCustomerBookingAvailability,
  getCustomerBookingRescheduleAvailability,
  listCustomerBookings,
  rescheduleCustomerBooking,
  getCustomerBookingExtensionOptions,
  extendCustomerBooking,
  cancelCustomerBookingExtensionPayment,
} from "./booking.customer.controller.js";

export const customerBookingRouter = Router();

customerBookingRouter.use(verifyJWT, requireCustomerSession);
customerBookingRouter.get(
  "/availability",
  requireTenantSubscriptionAccess,
  getCustomerBookingAvailability,
);
customerBookingRouter.get("/", listCustomerBookings);
customerBookingRouter.get("/:bookingId/extension/options", requireTenantSubscriptionAccess, getCustomerBookingExtensionOptions);
customerBookingRouter.post("/:bookingId/extension", requireTenantSubscriptionAccess, extendCustomerBooking);
customerBookingRouter.delete("/:bookingId/extension/pending", cancelCustomerBookingExtensionPayment);
customerBookingRouter.get(
  "/:bookingId/reschedule/availability",
  getCustomerBookingRescheduleAvailability,
);
customerBookingRouter.get("/:bookingId", getCustomerBooking);
customerBookingRouter
  .route("/:bookingId/cancel")
  .patch(cancelCustomerBooking)
  .post(cancelCustomerBooking);
customerBookingRouter.patch(
  "/:bookingId/reschedule",
  rescheduleCustomerBooking,
);

export default customerBookingRouter;
