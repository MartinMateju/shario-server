import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { logger } from "../../config/logger.js";
import { isE2ETestMode } from "../../config/e2e-mode.js";
import {
  getRequestLogPath,
  sanitizeLogText,
} from "../logging/request-log-sanitization.js";

export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  skip: () => isE2ETestMode(),

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    message:
      "Příliš mnoho pokusů o přihlášení, zkuste to prosím znovu za 1 minutu.",
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
        origin: sanitizeLogText(req.headers.origin, req),
        userAgent: sanitizeLogText(req.get("user-agent"), req),
        statusCode: options.statusCode,
      },
      "Login rate limit exceeded.",
    );

    res.status(options.statusCode).json(options.message);
  },
});
