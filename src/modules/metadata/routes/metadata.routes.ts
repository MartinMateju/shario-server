import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  createMetadata,
  createMetadataMany,
  listMetadata,
} from "../controllers/metadata.controller.js";

const router = express.Router();

router.use(verifyJWT);

router
  .route("/")
  .get(
    requirePermission(WORKSPACE_PERMISSION.WORKSPACE_VIEW),
    listMetadata,
  )
  .post(
    requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
    createMetadata,
  );
router.post(
  "/bulk",
  requirePermission(WORKSPACE_PERMISSION.WORKSPACE_UPDATE),
  createMetadataMany,
);

export default router;
