import type { Request, Response } from "express";
import Stripe from "stripe";

import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import { handleTenantPaymentConnectEvent } from "../services/tenant-payment-connect.webhook.service.js";
import { constructTenantPaymentConnectEvent } from "../tenant-payment.stripe.gateway.js";

export const tenantPaymentConnectWebhook = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.get("stripe-signature");

    if (typeof signature !== "string") {
      badRequest({
        message: "Missing Stripe signature.",
        code: "STRIPE_SIGNATURE_MISSING",
      });
    }

    if (!Buffer.isBuffer(req.body)) {
      badRequest({
        message: "Stripe webhook body must be raw.",
        code: "STRIPE_WEBHOOK_BODY_NOT_RAW",
      });
    }

    let event: Stripe.Event;

    try {
      event = constructTenantPaymentConnectEvent(req.body, signature);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        badRequest({
          message: "Invalid Stripe signature.",
          code: "STRIPE_SIGNATURE_INVALID",
        });
      }

      throw error;
    }

    await handleTenantPaymentConnectEvent(event);

    res.status(200).json({ received: true });
  },
);
