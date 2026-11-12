import express, { Router } from "express";

import { tenantSubscriptionWebhook } from "../controllers/tenant-subscription.webhook.controller.js";

export const tenantSubscriptionWebhookRouter = Router();

tenantSubscriptionWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  tenantSubscriptionWebhook,
);

export default tenantSubscriptionWebhookRouter;
