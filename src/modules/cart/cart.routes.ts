import express from "express";

import {
  requireCustomerSession,
  requireWorkspaceSession,
} from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  addCartItem,
  checkCreditsForCart,
  clearActiveCart,
  convertActiveCart,
  getCart,
  getCartsWithFilters,
  getUserCart,
  removeCartItem,
  updateCartItem,
} from "@/modules/cart/cart.controller.js";

const router = express.Router();

router.use(verifyJWT);

router.get("/", requireCustomerSession, getCart);
router.post("/items", requireCustomerSession, addCartItem);
router.patch(
  "/:cartId/items/:itemId",
  requireCustomerSession,
  updateCartItem,
);
router.delete(
  "/:cartId/items/:itemId",
  requireCustomerSession,
  removeCartItem,
);
router.post("/clear", requireCustomerSession, clearActiveCart);
router.patch(
  "/:cartId/convert",
  requireCustomerSession,
  convertActiveCart,
);
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
