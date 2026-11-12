import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  runBookingDeliveryUpdate,
  runCourseReminders,
} from "../controllers/access-code-jobs.controller.js";
import {
  archiveAccessCodePool,
  bulkCreateAccessCodes,
  createAccessCode,
  createAccessCodePool,
  getAccessCodeById,
  listAccessCodeAlerts,
  listAccessCodeAudit,
  listAccessCodePools,
  listAccessCodes,
  retireAccessCode,
  revealAccessCode,
  updateAccessCode,
  updateAccessCodePool,
} from "../controllers/access-code.controller.js";

export const accessCodeRouter = express.Router();

accessCodeRouter.use(verifyJWT);

const viewAccessCodes = requirePermission(
  WORKSPACE_PERMISSION.ACCESS_CODES_VIEW,
);
const manageAccessCodes = requirePermission(
  WORKSPACE_PERMISSION.ACCESS_CODES_MANAGE,
);
const revealAccessCodes = requirePermission(
  WORKSPACE_PERMISSION.ACCESS_CODES_REVEAL,
);
const importAccessCodes = requirePermission(
  WORKSPACE_PERMISSION.ACCESS_CODES_IMPORT,
);
const viewAccessCodeAudit = requirePermission(
  WORKSPACE_PERMISSION.ACCESS_CODES_AUDIT_VIEW,
);
const manageBookings = requirePermission(
  WORKSPACE_PERMISSION.BOOKINGS_UPDATE,
);

accessCodeRouter
  .route("/pools")
  .get(viewAccessCodes, listAccessCodePools)
  .post(manageAccessCodes, createAccessCodePool);
accessCodeRouter
  .route("/pools/:poolId")
  .patch(manageAccessCodes, updateAccessCodePool)
  .delete(manageAccessCodes, archiveAccessCodePool);

accessCodeRouter.post("/bulk", importAccessCodes, bulkCreateAccessCodes);
accessCodeRouter.get("/alerts", viewAccessCodes, listAccessCodeAlerts);
accessCodeRouter.get("/audit", viewAccessCodeAudit, listAccessCodeAudit);

// Legacy manual access-code sending is deliberately not exposed. These two
// non-code jobs remain during their separate migration to automation workers.
accessCodeRouter.post(
  "/jobs/reminders",
  manageBookings,
  runCourseReminders,
);
accessCodeRouter.post(
  "/jobs/deliveries",
  manageBookings,
  runBookingDeliveryUpdate,
);

accessCodeRouter
  .route("/")
  .get(viewAccessCodes, listAccessCodes)
  .post(manageAccessCodes, createAccessCode);
accessCodeRouter.post("/:id/reveal", revealAccessCodes, revealAccessCode);
accessCodeRouter
  .route("/:id")
  .get(viewAccessCodes, getAccessCodeById)
  .patch(manageAccessCodes, updateAccessCode)
  .delete(manageAccessCodes, retireAccessCode);

export default accessCodeRouter;

