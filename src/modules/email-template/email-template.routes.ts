import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  createEmailTemplate,
  deleteEmailTemplate,
  getEmailTemplateById,
  getEmailTemplates,
  setDefaultEmailTemplate,
  toggleEmailTemplateActive,
  updateEmailTemplate,
} from "./controllers/email-template.controller.js";

const router = express.Router();

router.use(verifyJWT);

const viewCommunications = requirePermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
);
const manageCommunications = requirePermission(
  WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
);

router.route("/").get(viewCommunications, getEmailTemplates).post(
  manageCommunications,
  createEmailTemplate,
);

router.patch("/:id/toggle-active", manageCommunications, toggleEmailTemplateActive);
router.patch("/:id/set-default", manageCommunications, setDefaultEmailTemplate);

router
  .route("/:id")
  .get(viewCommunications, getEmailTemplateById)
  .patch(manageCommunications, updateEmailTemplate)
  .delete(manageCommunications, deleteEmailTemplate);

export default router;
