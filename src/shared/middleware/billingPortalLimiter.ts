import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { logger } from "@/config/logger.js";
import { getRequestLogPath } from "@/shared/logging/request-log-sanitization.js";

export const billingPortalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "BILLING_PORTAL_RATE_LIMITED",
    message: "Too many Billing Portal requests. Please wait one minute.",
  },
  handler: (
    req: Request,
    res: Response,
    _next,
    options,
  ): void => {
    logger.warn(
      {
        ip: req.ip,
        method: req.method,
        path: getRequestLogPath(req),
        statusCode: options.statusCode,
      },
      "Stripe Billing Portal rate limit exceeded.",
    );

    res.status(options.statusCode).json(options.message);
  },
});
