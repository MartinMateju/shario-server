import type { Request, Response } from "express";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  constructTenantBillingEvent,
  handleTenantBillingEvent,
} from "../services/tenant-subscription.webhook.service.js";

export const tenantSubscriptionWebhook = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.get("stripe-signature");

    if (typeof signature !== "string") {
      badRequest("Missing Stripe signature.");
    }

    if (!Buffer.isBuffer(req.body)) {
      badRequest("Stripe webhook body must be raw.");
    }

    const event = constructTenantBillingEvent(req.body, signature);
    await handleTenantBillingEvent(event);

    res.status(200).json({ received: true });
  },
);
