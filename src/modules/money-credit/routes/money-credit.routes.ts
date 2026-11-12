import express from "express";

import {
  addCredits,
  adminGrantCredits,
  getCreditBalance,
  getCreditTransactions,
  getMyCreditBalance,
  getMyCreditTransactions,
  purchaseCredits,
  refundCredits,
  useCredits,
} from "../controllers/money-credit.controller.js";
import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

const router = express.Router();

router.use(verifyJWT);

const manageCredits = requirePermission(WORKSPACE_PERMISSION.CREDITS_MANAGE);

router.get(
  "/mine/balance",
  requireCustomerSession,
  getMyCreditBalance,
);
router.get(
  "/mine/transactions",
  requireCustomerSession,
  getMyCreditTransactions,
);

router.get("/balance/:userId", getCreditBalance);
router.get("/transactions/:userId", getCreditTransactions);

router.post("/purchase", requireCustomerSession, purchaseCredits);

router.post("/add", manageCredits, addCredits);
router.post("/use", manageCredits, useCredits);
router.post("/refund", manageCredits, refundCredits);
router.post("/admin/grant", manageCredits, adminGrantCredits);

export default router;
