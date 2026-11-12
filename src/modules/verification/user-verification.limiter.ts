import rateLimit from "express-rate-limit";

import { isE2ETestMode } from "@/config/e2e-mode.js";

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isE2ETestMode(),
};

export const emailVerificationRequestLimiter =
  rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: {
      message:
        "Too many verification email requests. Please try again later.",
      code:
        "EMAIL_VERIFICATION_RATE_LIMITED",
    },
  });

export const emailVerificationVerifyLimiter =
  rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 20,
    message: {
      message:
        "Too many verification attempts. Please try again later.",
      code:
        "EMAIL_VERIFICATION_RATE_LIMITED",
    },
  });
