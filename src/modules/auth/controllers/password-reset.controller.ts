import type { Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest } from "../../../shared/http/httpErrors.js";
import type { AuthenticatedRequest } from "../auth.types.js";
import {
  passwordResetRequestSchema,
  passwordResetSchema,
  validateBody,
  verifyOtpSchema,
} from "../auth.validators.js";
import {
  requestPasswordReset,
  resetPasswordWithOtp,
  verifyPasswordResetOtp,
} from "../services/password-reset.service.js";

export const requestPasswordResetController = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.tenant) {
      badRequest("Tenant context is required for password reset.");
    }

    const input = validateBody(passwordResetRequestSchema, req.body);
    const result = await requestPasswordReset({ input, tenant: req.tenant });

    res.status(200).json({
      status: result.status,
      message: "Password reset email sent if the account exists.",
    });
  },
);

export const verifyOtp = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.tenant) {
      badRequest("Tenant context is required for password reset.");
    }

    const input = validateBody(verifyOtpSchema, req.body);
    const result = await verifyPasswordResetOtp({ input, tenant: req.tenant });

    res.status(200).json(result);
  },
);

export const resetPassword = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.tenant) {
      badRequest("Tenant context is required for password reset.");
    }

    const input = validateBody(passwordResetSchema, req.body);
    const result = await resetPasswordWithOtp({ input, tenant: req.tenant });

    res.status(200).json({
      status: result.status,
      message: "Password has been reset successfully.",
    });
  },
);
