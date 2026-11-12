import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { logger } from "@/config/logger.js";

export const registeredSenderEmailTestLimiter = rateLimit({
  windowMs: 60 * 1_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: "SMTP_TEST_RATE_LIMITED",
    message: "Too many SMTP connection tests. Please wait one minute.",
  },
  handler: (req: Request, res: Response, _next, options): void => {
    logger.warn(
      {
        ip: req.ip,
        method: req.method,
        path: req.path,
        statusCode: options.statusCode,
      },
      "Registered sender SMTP test rate limit exceeded.",
    );

    res.status(options.statusCode).json(options.message);
  },
});
