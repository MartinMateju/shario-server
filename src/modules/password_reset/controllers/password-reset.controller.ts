import type {
  Request,
  Response,
} from "express";

import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import { getTenantBySlug } from "@/modules/tenants/services/tenant.service.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

import { createPasswordResetEmailService } from "../services/password-reset-email.service.js";
import { createPasswordResetService } from "../services/password-reset.service.js";
import {
  requestPasswordResetSchema,
  resetPasswordWithOtpSchema,
  verifyPasswordResetOtpSchema,
} from "../password-reset.validators.js";

const passwordResetService =
  createPasswordResetService(
    createPasswordResetEmailService(
      sendEmail,
    ),
  );

const genericPendingResponse = (
  res: Response,
): void => {
  res.status(202).json({
    status: "PENDING",
    message:
      "If an account exists for this email, a reset code will be sent.",
  });
};

const resolveTenant = async (
  tenantSlug: string,
) => {
  return getTenantBySlug(
    tenantSlug,
  );
};

const resolveEmailLocale = (
  value: unknown,
): "cs" | "en" =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .startsWith("en")
    ? "en"
    : "cs";

const rejectInvalidReset = (): never =>
  unauthorized({
    message:
      "The password reset details are invalid or expired.",
    code: "INVALID_PASSWORD_RESET",
  });

export const requestPasswordReset =
  asyncHandler(
    async (
      req: Request,
      res: Response,
    ) => {
      const input =
        requestPasswordResetSchema.parse(
          req.body,
        );
      const tenant =
        await resolveTenant(
          input.tenantSlug,
        );

      /*
       * The request endpoint is deliberately indistinguishable for an
       * unknown tenant, unknown email, or mail-provider failure.
       */
      if (tenant) {
        try {
          await passwordResetService.requestReset(
            {
              tenantId: String(
                tenant._id,
              ),
              email: input.email,
              locale:
                input.locale ??
                resolveEmailLocale(
                  tenant.settings
                    ?.defaultLanguage,
                ),
              studioName:
                tenant.publicSite
                  ?.branding
                  ?.displayName ||
                tenant.name,
            },
          );
        } catch (error) {
          logger.error(
            {
              err: error,
              tenantId: String(
                tenant._id,
              ),
            },
            "Password reset request delivery failed.",
          );
        }
      }

      genericPendingResponse(res);
    },
  );

export const verifyPasswordResetOtp =
  asyncHandler(
    async (
      req: Request,
      res: Response,
    ) => {
      const input =
        verifyPasswordResetOtpSchema.parse(
          req.body,
        );
      const tenant =
        await resolveTenant(
          input.tenantSlug,
        );

      if (!tenant) {
        rejectInvalidReset();
      }

      const result =
        await passwordResetService.verifyOtp(
          {
            tenantId: String(
              tenant._id,
            ),
            email: input.email,
            otp: input.otp,
          },
        );

      res.status(200).json(result);
    },
  );

export const resetPasswordWithOtp =
  asyncHandler(
    async (
      req: Request,
      res: Response,
    ) => {
      const input =
        resetPasswordWithOtpSchema.parse(
          req.body,
        );
      const tenant =
        await resolveTenant(
          input.tenantSlug,
        );

      if (!tenant) {
        rejectInvalidReset();
      }

      const result =
        await passwordResetService.resetPassword(
          {
            tenantId: String(
              tenant._id,
            ),
            resetToken:
              input.resetToken,
            password:
              input.password,
          },
        );

      res.status(200).json({
        ...result,
        message:
          "Password has been reset successfully.",
      });
    },
  );
