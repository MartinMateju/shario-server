import express from "express";

import {
  requestPasswordReset,
  resetPasswordWithOtp,
  verifyPasswordResetOtp,
} from "../controllers/password-reset.controller.js";
import {
  passwordResetRequestLimiter,
  passwordResetVerifyLimiter,
} from "../password-reset.limiter.js";

export const passwordResetRouter = express.Router();

passwordResetRouter.post(
  "/request",
  passwordResetRequestLimiter,
  requestPasswordReset,
);
passwordResetRouter.post(
  "/verify-otp",
  passwordResetVerifyLimiter,
  verifyPasswordResetOtp,
);
passwordResetRouter.post(
  "/reset",
  passwordResetVerifyLimiter,
  resetPasswordWithOtp,
);

export default passwordResetRouter;
