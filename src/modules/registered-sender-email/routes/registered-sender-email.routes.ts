import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireAnyPermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { registeredSenderEmailTestLimiter } from "../registered-sender-email.limiter.js";

import {
  createRegisteredSenderEmail,
  confirmRegisteredSenderReplyToVerification,
  deactivateRegisteredSenderEmail,
  getRegisteredSenderEmailDetails,
  getRegisteredSenderEmails,
  requestRegisteredSenderReplyToVerification,
  testRegisteredSenderEmail,
  updateRegisteredSenderEmail,
} from "../controllers/registered-sender-email.controller.js";

const router = express.Router();

router.use(verifyJWT);

const viewCommunications = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
  WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);
const manageCommunications = requireAnyPermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);

router
  .route("/")
  .get(viewCommunications, getRegisteredSenderEmails)
  .post(manageCommunications, createRegisteredSenderEmail);

router
  .route("/:id")
  .get(viewCommunications, getRegisteredSenderEmailDetails)
  .patch(manageCommunications, updateRegisteredSenderEmail);

router.patch(
  "/:id/test",
  manageCommunications,
  registeredSenderEmailTestLimiter,
  testRegisteredSenderEmail,
);
router.post(
  "/:id/reply-to-verification",
  manageCommunications,
  registeredSenderEmailTestLimiter,
  requestRegisteredSenderReplyToVerification,
);
router.post(
  "/:id/reply-to-verification/confirm",
  manageCommunications,
  registeredSenderEmailTestLimiter,
  confirmRegisteredSenderReplyToVerification,
);
router.patch(
  "/:id/deactivate",
  manageCommunications,
  deactivateRegisteredSenderEmail,
);

export default router;
