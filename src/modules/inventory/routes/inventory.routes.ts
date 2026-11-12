import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  completeInventoryAudit,
  createInventoryAudit,
  createInventoryItem,
  createInventoryMovement,
  createReorderRequest,
  getInventoryAudits,
  getInventoryItem,
  getInventoryItems,
  getInventoryMovements,
  getReorderRequests,
  receiveReorderRequest,
  updateInventoryAudit,
  updateInventoryItem,
  updateReorderRequest,
} from "../controllers/inventory.controller.js";

const router = express.Router();

router.use(verifyJWT);

const viewInventory = requirePermission(WORKSPACE_PERMISSION.INVENTORY_VIEW);
const manageInventory = requirePermission(WORKSPACE_PERMISSION.INVENTORY_MANAGE);

router.route("/items").get(viewInventory, getInventoryItems).post(
  manageInventory,
  createInventoryItem,
);
router
  .route("/items/:id")
  .get(viewInventory, getInventoryItem)
  .patch(manageInventory, updateInventoryItem);

router.route("/movements").get(viewInventory, getInventoryMovements).post(
  manageInventory,
  createInventoryMovement,
);

router.route("/audits").get(viewInventory, getInventoryAudits).post(
  manageInventory,
  createInventoryAudit,
);
router.route("/audits/:id").patch(manageInventory, updateInventoryAudit);
router.route("/audits/:id/complete").patch(manageInventory, completeInventoryAudit);

router
  .route("/reorders")
  .get(viewInventory, getReorderRequests)
  .post(manageInventory, createReorderRequest);
router.route("/reorders/:id").patch(manageInventory, updateReorderRequest);
router
  .route("/reorders/:id/receive")
  .patch(manageInventory, receiveReorderRequest);

export default router;
