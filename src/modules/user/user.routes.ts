import express from "express";

import { requireWorkspaceSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { getCustomerBookingHistory } from "@/modules/booking/controllers/booking.read.controller.js";

import {
  getCustomerById,
  getAllUsers,
  getUserbyCustomId,
  getUsersWithFilters,
  lookupUser,
} from "./controllers/user.read.controller.js";

import {
  createNewUser,
  deleteUser,
  updateUser,
  updateUserPassword,
} from "./controllers/user.write.controller.js";

const router = express.Router();

router.use(verifyJWT);

const canViewUsers = requirePermission(WORKSPACE_PERMISSION.CUSTOMERS_VIEW);
const canManageUsers = requirePermission(WORKSPACE_PERMISSION.CUSTOMERS_MANAGE);
const canViewBookings = requirePermission(WORKSPACE_PERMISSION.BOOKINGS_VIEW);

router
  .route("/")
  .get(canViewUsers, getAllUsers)
  .post(canManageUsers, createNewUser)
  .patch(canManageUsers, updateUser)
  .delete(canManageUsers, deleteUser);

router.post("/filter", canViewUsers, getUsersWithFilters);
router.get("/lookup", canViewUsers, lookupUser);
router.patch("/pass", requireWorkspaceSession, updateUserPassword);

router.get(
  "/:id/bookings",
  canViewUsers,
  canViewBookings,
  getCustomerBookingHistory,
);
router.get("/:id", canViewUsers, getCustomerById);

// Compatibility with legacy frontend route. Prefer GET /users/by-custom-id/:customId later.
router.get("/:customId/:userId", canViewUsers, getUserbyCustomId);

export default router;
