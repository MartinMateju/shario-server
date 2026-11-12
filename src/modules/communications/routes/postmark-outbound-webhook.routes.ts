import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { POSTMARK_PROVISIONING_TOKEN_HEADER } from "@/infrastructure/email/postmark-webhook-provisioning.js";
import { isValidPostmarkWebhookAuthorization } from "../postmark-outbound-webhook.auth.js";
import { postmarkOutboundWebhookPayloadSchema } from "../postmark-outbound-webhook.validators.js";
import {
  isManagedPostmarkProvisioningAttemptActive,
  processPostmarkOutboundWebhook,
} from "../services/postmark-outbound-webhook.service.js";

export const postmarkOutboundWebhookRouter = express.Router();

const requirePostmarkBasicAuth = (
  request: Request,
  response: Response,
  next: NextFunction,
) => {
  if (isValidPostmarkWebhookAuthorization(request.get("authorization"))) {
    next();
    return;
  }
  response.set("WWW-Authenticate", 'Basic realm="Postmark outbound webhook"');
  response.status(401).json({
    status: "fail",
    code: "POSTMARK_WEBHOOK_UNAUTHORIZED",
    message: "Webhook authentication failed.",
  });
};

postmarkOutboundWebhookRouter.post(
  "/",
  requirePostmarkBasicAuth,
  express.json({
    limit: "32kb",
    strict: true,
    type: ["application/json", "application/*+json"],
  }),
  async (request: Request, response: Response, next: NextFunction) => {
    const parsed = postmarkOutboundWebhookPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        status: "fail",
        code: "POSTMARK_WEBHOOK_INVALID_PAYLOAD",
        message: "Webhook payload is invalid.",
      });
      return;
    }
    const expectedStream = String(
      process.env.POSTMARK_MESSAGE_STREAM || "outbound",
    ).trim();
    if (parsed.data.MessageStream !== expectedStream) {
      response.status(400).json({
        status: "fail",
        code: "POSTMARK_WEBHOOK_STREAM_MISMATCH",
        message: "Webhook message stream is not supported.",
      });
      return;
    }
    try {
      const result = await processPostmarkOutboundWebhook(parsed.data);
      if (!result.matched) {
        if (result.correlationMismatch) {
          // Authentication succeeded, but the provider fields do not match
          // our persisted recipient/Server. Fail closed without asking
          // Postmark to retry a permanently unprocessable event forever.
          response.status(200).json({
            ok: true,
            ignored: true,
            code: "POSTMARK_MESSAGE_CORRELATION_MISMATCH",
          });
          return;
        }
        const metadata = parsed.data.Metadata || {};
        const hasSharioCorrelationMetadata = [
          "tenantId",
          "managedSenderId",
          "idempotencyKey",
          "deliveryId",
          "messageId",
          "emailLogId",
          "automationId",
          "orderId",
        ].some((key) => Boolean(metadata[key]));
        if (
          !hasSharioCorrelationMetadata &&
          // Verification samples need not carry the real tenant ServerID.
          // Correlate with our short-lived setup attempt instead. After setup,
          // Postmark's persisted header is inert because the attempt is cleared.
          (await isManagedPostmarkProvisioningAttemptActive(
            request.get(POSTMARK_PROVISIONING_TOKEN_HEADER),
          ))
        ) {
          response.status(200).json({
            ok: true,
            ignored: true,
            code: "POSTMARK_PROVISIONING_PROBE_ACCEPTED",
          });
          return;
        }
        // The provider can win the race with our accepted-result persistence.
        // A non-2xx response asks Postmark to retry after the MessageID exists.
        response.status(503).json({
          status: "retry",
          code: "POSTMARK_MESSAGE_NOT_READY",
          message: "Provider message is not ready for reconciliation.",
        });
        return;
      }
      response.status(200).json({
        ok: true,
        deliveryUpdated: result.deliveryUpdated,
        automationLogUpdated: result.automationLogUpdated,
        managedTestUpdated: result.managedTestUpdated,
        orderReceiptUpdated: result.orderReceiptUpdated,
        suppressions: result.suppressions,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default postmarkOutboundWebhookRouter;
