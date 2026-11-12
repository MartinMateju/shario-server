import express from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";

import {
  createSupplier,
  deleteSupplier,
  getSuppliers,
  updateSupplier,
} from "../controllers/supplier.controller.js";
import {
  createSupplyOrder,
  deleteSupplyOrder,
  getSupplyOrderById,
  getSupplyOrders,
  updateSupplyOrder,
} from "../controllers/supply-order.controller.js";

const router = express.Router();

router.use(verifyJWT);

const viewInventory = requirePermission(WORKSPACE_PERMISSION.INVENTORY_VIEW);
const manageInventory = requirePermission(WORKSPACE_PERMISSION.INVENTORY_MANAGE);
const inventoryModule = requireTenantModule(TENANT_MODULE.INVENTORY);

router.route("/orders").get(viewInventory, getSupplyOrders).post(
  manageInventory,
  createSupplyOrder,
);

router
  .route("/orders/:id")
  .get(viewInventory, getSupplyOrderById)
  .patch(manageInventory, updateSupplyOrder)
  .delete(manageInventory, deleteSupplyOrder);

router.use("/suppliers", inventoryModule);

router.route("/suppliers").get(viewInventory, getSuppliers).post(
  manageInventory,
  createSupplier,
);

router
  .route("/suppliers/:id")
  .patch(manageInventory, updateSupplier)
  .delete(manageInventory, deleteSupplier);

export default router;
