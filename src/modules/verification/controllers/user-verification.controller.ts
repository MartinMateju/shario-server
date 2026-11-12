import type {
  Request,
  Response,
} from "express";

import { logger } from "@/config/logger.js";
import { findPublishedTenantBySlug } from "@/modules/setup-center/setup-publication.service.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

import { verificationService } from "../services/user-verification.service.js";
import {
  requestEmailVerificationSchema,
  verifyEmailSchema,
} from "../user-verification.validators.js";

const sendGenericPending = (
  res: Response,
): void => {
  res.status(202).json({
    status: "PENDING",
    message:
      "If an unverified account exists for this email, a verification link will be sent.",
  });
};

const requestVerification =
  asyncHandler(
    async (
      req: Request,
      res: Response,
    ) => {
      const input =
        requestEmailVerificationSchema.parse(
          req.body,
        );
      const tenant =
        await findPublishedTenantBySlug(
          input.tenantSlug,
        );

      /*
       * Tenant, account and delivery-provider misses deliberately share one
       * response to prevent account enumeration.
       */
      if (tenant) {
        try {
          await verificationService.requestVerificationEmail(
            {
              tenant,
              email: input.email,
              next: input.next,
              locale: input.locale,
              requestedOrigin:
                req.get("origin") ||
                undefined,
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
            "Verification email delivery failed.",
          );
        }
      }

      sendGenericPending(res);
    },
  );

export const requestCustomerEmailVerification =
  requestVerification;

export const resendCustomerEmailVerification =
  requestVerification;

export const verifyCustomerEmail =
  asyncHandler(
    async (
      req: Request,
      res: Response,
    ) => {
      const input =
        verifyEmailSchema.parse(
          req.body,
        );
      const tenant =
        await findPublishedTenantBySlug(
          input.tenantSlug,
        );

      if (!tenant) {
        unauthorized({
          message:
            "The email verification link is invalid or expired.",
          code:
            "INVALID_EMAIL_VERIFICATION",
        });
      }

      await verificationService.verifyEmail(
        {
          tenantId: String(
            tenant._id,
          ),
          token: input.token,
        },
      );

      res.status(200).json({
        status: "VERIFIED",
        verified: true,
        message:
          "Email was verified successfully.",
      });
    },
  );

/*
 * Compatibility aliases. New integrations should mount the explicit
 * customer endpoints under /auth/customer/email-verification.
 */
export const resendVerificationEmail =
  resendCustomerEmailVerification;
export const verifyEmail =
  verifyCustomerEmail;
