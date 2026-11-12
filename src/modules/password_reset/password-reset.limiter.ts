import rateLimit from "express-rate-limit";

import { isE2ETestMode } from "@/config/e2e-mode.js";

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isE2ETestMode(),
};

export const passwordResetRequestLimiter =
  rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: {
      message:
        "Too many password reset requests. Please try again later.",
      code: "PASSWORD_RESET_RATE_LIMITED",
    },
  });

export const passwordResetVerifyLimiter =
  rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 12,
    message: {
      message:
        "Too many password reset attempts. Please try again later.",
      code: "PASSWORD_RESET_RATE_LIMITED",
    },
  });
