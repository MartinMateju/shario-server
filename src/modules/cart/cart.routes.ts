import express from "express";

import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  checkCreditsForCart,
  getCart,
  getCartsWithFilters,
  getUserCart,
} from "@/modules/cart/cart.controller.js";

const router = express.Router();

router.use(verifyJWT);

router.get("/", requireCustomerSession, getCart);
// The legacy customer cart mutation routes (add/update/remove item, clear,
// convert) were removed: no client calls them, and they let a customer rewrite
// the price snapshot of a paid order's cart, which booking-extension pricing
// reads. Carts are written only by the checkout services.
router.post(
  "/check-credits",
  requireCustomerSession,
  checkCreditsForCart,
);

router.get(
  "/:userId",
  requireWorkspaceSession,
  requirePermission(WORKSPACE_PERMISSION.CUSTOMERS_VIEW),
  getUserCart,
);
router.post(
  "/filter",
  requireWorkspaceSession,
  requirePermission(WORKSPACE_PERMISSION.ORDERS_VIEW),
  getCartsWithFilters,
);

export default router;
