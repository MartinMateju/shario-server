import express, { Router } from "express";

import { tenantPaymentConnectWebhook } from "../controllers/tenant-payment-connect.webhook.controller.js";

export const tenantPaymentConnectWebhookRouter = Router();

tenantPaymentConnectWebhookRouter.post(
  "/",
  express.raw({ type: "application/json", limit: "1mb" }),
  tenantPaymentConnectWebhook,
);

export default tenantPaymentConnectWebhookRouter;

