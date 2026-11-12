import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  createEvent,
  deleteEvent,
  getEvent,
  getEvents,
  updateEvent,
} from "../controllers/event.controller.js";

const router = express.Router();

router.use(verifyJWT);

const manageEvents = requirePermission(WORKSPACE_PERMISSION.COURSES_MANAGE);
const viewEvents = requirePermission(WORKSPACE_PERMISSION.COURSES_VIEW);

router.route("/").get(viewEvents, getEvents).post(manageEvents, createEvent);

router
  .route("/:id")
  .get(viewEvents, getEvent)
  .patch(manageEvents, updateEvent)
  .delete(manageEvents, deleteEvent);

export default router;
