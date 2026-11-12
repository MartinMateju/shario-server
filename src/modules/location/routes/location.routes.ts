import express from "express";

import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import {
  requireLocationAccess,
  requirePermission,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  activateLocation,
  bootstrapLocation,
  createLocation,
  deactivateLocation,
  deleteLocation,
  getCustomerLocations,
  getLocationById,
  getLocations,
  setPrimaryLocation,
  updateLocation,
} from "../controllers/location.controller.js";

const router = express.Router();
const manageLocations = requirePermission(
  WORKSPACE_PERMISSION.LOCATIONS_MANAGE,
);
const viewLocations = requirePermission(WORKSPACE_PERMISSION.LOCATIONS_VIEW);
const accessLocation = requireLocationAccess((req) => req.params.id);

router.use(verifyJWT);
router.get("/customer", requireCustomerSession, getCustomerLocations);
router.use(requireWorkspaceSession);

router
  .route("/")
  .get(viewLocations, getLocations)
  .post(manageLocations, createLocation);

router.post("/bootstrap", manageLocations, bootstrapLocation);

router.patch(
  "/:id/set-primary",
  manageLocations,
  accessLocation,
  setPrimaryLocation,
);
router.patch(
  "/:id/activate",
  manageLocations,
  accessLocation,
  activateLocation,
);
router.patch(
  "/:id/deactivate",
  manageLocations,
  accessLocation,
  deactivateLocation,
);

router
  .route("/:id")
  .get(viewLocations, accessLocation, getLocationById)
  .patch(manageLocations, accessLocation, updateLocation)
  .delete(manageLocations, accessLocation, deleteLocation);

export default router;
