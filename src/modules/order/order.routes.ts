import express from "express";

import {
  getAdminOrder,
  getOrdersWithFilters,
  listAdminOrders,
} from "./controllers/order.admin.controller.js";

// Adjust these imports to your final auth module paths.
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const router = express.Router();

router.use(verifyJWT);

router.get(
  "/",
  requirePermission(WORKSPACE_PERMISSION.ORDERS_VIEW),
  listAdminOrders,
);

router.post(
  "/filter",
  requirePermission(WORKSPACE_PERMISSION.ORDERS_VIEW),
  getOrdersWithFilters,
);

router.get(
  "/:id",
  requirePermission(WORKSPACE_PERMISSION.ORDERS_VIEW),
  getAdminOrder,
);

export { router as orderRouter };
export default router;
