import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requireCustomerSession } from "@/modules/auth/middleware/requireAuthContext.js";

import {
  getAccount,
  updateAccountPassword,
  updateAccountProfile,
  updateCustomerPreferences,
} from "./account.controller.js";

export const accountRouter = Router();

accountRouter.use(verifyJWT);
accountRouter.get("/", getAccount);
accountRouter.patch("/profile", updateAccountProfile);
accountRouter.patch(
  "/customer-preferences",
  requireCustomerSession,
  updateCustomerPreferences,
);
accountRouter.patch("/password", updateAccountPassword);

export default accountRouter;
