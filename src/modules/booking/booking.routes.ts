import express from "express";

import { requireWorkspaceSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireLocationAccess,
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import Booking from "./booking.model.js";
import mongoose from "mongoose";
import {
  readBookingEditor,
  writeBookingEditor,
  lookupBookingEditorCustomer,
} from "./controllers/booking.editor.controller.js";

import { createCourseBookingRecords } from "./controllers/booking.course.controller.js";

import {
  getBookings,
  getBookingsByProductId,
  getBookingsByUserId,
  getBookingsHistory,
  getBookingsWithFilters,
  getUserBookings,
} from "./controllers/booking.read.controller.js";

import {
  cancelBooking,
  updateBooking,
} from "./controllers/booking.write.controller.js";
import { deleteBookingRequiresCancellation } from "./controllers/booking.delete-deprecation.controller.js";
import { participantIncreaseRequiresCheckout } from "./controllers/booking.participant-increase.controller.js";
import { cancelCourseOrderParticipants } from "./controllers/booking.course-participant-cancellation.controller.js";
import {
  cancelAdminWaitlistEntry,
  getAdminWaitlist,
  getAdminWaitlistSettings,
  patchAdminWaitlistSettings,
  promoteAdminWaitlistEntry,
  resendAdminWaitlistOffer,
} from "@/modules/waitlist/waitlist.admin.controller.js";

const router = express.Router();

const createBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_CREATE);
const viewBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_VIEW);
const updateBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_UPDATE);
const cancelBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_CANCEL);
const refundBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_REFUND);
const coursesModule = requireTenantModule(TENANT_MODULE.COURSES);
const paymentsModule = requireTenantModule(TENANT_MODULE.PAYMENTS);
const waitlistLocationAccess = requireLocationAccess(async (req) => {
  if (!mongoose.isValidObjectId(req.params.sessionId)) return null;
  const session = await Booking.findOne({
    _id: req.params.sessionId,
    tenant: requireTenantId(req),
  })
    .select("location")
    .lean()
    .exec();
  return session?.location;
});

router.use(verifyJWT, requireWorkspaceSession);

const editorLocationAccess = requireLocationAccess(async (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) return null;
  const booking = await Booking.findOne({
    _id: req.params.id,
    tenant: requireTenantId(req),
  })
    .select("location")
    .lean()
    .exec();
  return booking?.location;
});
router.get(
  "/:id/editor/customer",
  updateBookings,
  editorLocationAccess,
  lookupBookingEditorCustomer,
);
router
  .route("/:id/editor")
  .get(viewBookings, editorLocationAccess, readBookingEditor)
  .put(updateBookings, editorLocationAccess, writeBookingEditor);

router
  .route("/")
  .get(viewBookings, getBookings)
  .post(
    createBookings,
    requireLocationAccess((req) => req.body.locationId),
    createCourseBookingRecords,
  )
  .patch(updateBookings, updateBooking)
  .delete(cancelBookings, deleteBookingRequiresCancellation);

router.get("/history", viewBookings, getBookingsHistory);
router.post("/filter", viewBookings, getBookingsWithFilters);
router.patch("/user", viewBookings, getBookingsByUserId);
router.get("/user-bookings", getUserBookings);

router.patch("/cancel", cancelBookings, refundBookings, cancelBooking);
router.put("/increase-participants", participantIncreaseRequiresCheckout);

router.delete(
  "/:sessionId/participants/:orderId",
  coursesModule,
  cancelBookings,
  refundBookings,
  waitlistLocationAccess,
  cancelCourseOrderParticipants,
);

router.get("/product/:productId", getBookingsByProductId);

router.get(
  "/:sessionId/waitlist",
  coursesModule,
  viewBookings,
  waitlistLocationAccess,
  getAdminWaitlist,
);
router
  .route("/:sessionId/waitlist/settings")
  .get(
    coursesModule,
    viewBookings,
    waitlistLocationAccess,
    getAdminWaitlistSettings,
  )
  .patch(
    coursesModule,
    paymentsModule,
    updateBookings,
    waitlistLocationAccess,
    patchAdminWaitlistSettings,
  );
router.post(
  "/:sessionId/waitlist/:entryId/promote",
  coursesModule,
  paymentsModule,
  updateBookings,
  waitlistLocationAccess,
  promoteAdminWaitlistEntry,
);
router.post(
  "/:sessionId/waitlist/:entryId/resend",
  coursesModule,
  paymentsModule,
  updateBookings,
  waitlistLocationAccess,
  resendAdminWaitlistOffer,
);
router.delete(
  "/:sessionId/waitlist/:entryId",
  coursesModule,
  cancelBookings,
  waitlistLocationAccess,
  cancelAdminWaitlistEntry,
);

export default router;
