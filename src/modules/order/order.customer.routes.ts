import { Router } from "express";

import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";
import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";

import {
  getCustomerOrderConfirmation,
} from "./order.customer.controller.js";

export const customerOrderRouter = Router();

customerOrderRouter.use(verifyJWT, requireCustomerSession);
customerOrderRouter.get(
  "/:orderId/confirmation",
  getCustomerOrderConfirmation,
);

export default customerOrderRouter;
