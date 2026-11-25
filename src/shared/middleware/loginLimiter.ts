import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { prepareAuthRateLimitContext } from "@/modules/auth/auth-first-party-proxy.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { verifiedProxyRateLimitKey } from "./verified-proxy-rate-limit.js";

import { logger } from "../../config/logger.js";
import { isE2ETestMode } from "../../config/e2e-mode.js";
import {
  getRequestLogPath,
  sanitizeLogText,
} from "../logging/request-log-sanitization.js";

const rateLimitedLogin = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  skip: () => isE2ETestMode(),
  // The Vercel BFF signs the edge-provided browser IP. Ordinary forwarded
  // headers are never used here, and v1/direct requests retain their old key.
  keyGenerator: verifiedProxyRateLimitKey,

  standardHeaders: true,
  legacyHeaders: false,

  message: {
    message:
      "Příliš mnoho pokusů o přihlášení, zkuste to prosím znovu za 1 minutu.",
  },

  handler: (req: Request, res: Response, _next, options): void => {
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

export const loginLimiter = asyncHandler(async (req, res, next) => {
  await prepareAuthRateLimitContext(req);
  return rateLimitedLogin(req, res, next);
});
