import mongoose from "mongoose";

import { logger } from "@/config/logger.js";
import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";
import UserModel from "@/modules/user/user.model.js";
import { unauthorized } from "@/shared/http/httpErrors.js";
import { resolveCommunicationContentLocale } from "@/shared/i18n/communication-locales.js";
import type { RolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import { EMAIL_VERIFICATION_EXPIRES_IN_MS } from "../user-verification.constants.js";
import {
  buildRegistrationConfirmationEmail,
  buildVerificationEmail,
} from "../user-verification.email.js";
import { verificationRepository } from "../user-verification.repository.js";
import type {
  SendRegistrationConfirmationInput,
  SendVerificationEmailInput,
  VerificationTenant,
  VerifyEmailInput,
} from "../user-verification.types.js";
import {
  addMilliseconds,
  buildEmailVerificationUrl,
  createVerificationToken,
  hashVerificationToken,
  normalizeVerificationLocale,
} from "../user-verification.utils.js";

const toObjectId = (
  value: unknown,
): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId(
    String(value),
  );

const getTenantId = (
  tenant: VerificationTenant,
): string =>
  String(
    tenant._id ??
      tenant.id ??
      "",
  ).trim();

const getStudioName = (
  tenant: VerificationTenant,
): string =>
  String(
    tenant.publicSite?.branding
      ?.displayName ||
      tenant.name ||
      "Studio",
  ).trim();

const rejectInvalidVerification =
  (): never =>
    unauthorized({
      message:
        "The email verification link is invalid or expired.",
      code:
        "INVALID_EMAIL_VERIFICATION",
    });

export const verificationService = {
  async sendVerificationEmail(
    input: SendVerificationEmailInput,
  ) {
    const tenantId = getTenantId(
      input.tenant,
    );
    const normalizedEmail =
      input.email
        .trim()
        .toLowerCase();

    if (!tenantId) {
      throw new Error(
        "Tenant ID is required to send a verification email.",
      );
    }

    const user =
      await UserModel.findOne({
        _id: toObjectId(
          input.userId,
        ),
        tenant:
          toObjectId(tenantId),
        email: normalizedEmail,
      })
        .select(
          "_id email isEmailVerified",
        )
        .exec();

    /*
     * Callers return a generic response. A missing or already verified user
     * never causes a different public response and receives no new token.
     */
    if (
      !user ||
      user.isEmailVerified === true
    ) {
      return {
        sent: false,
      };
    }

    await verificationRepository.deletePendingEmailTokens(
      tenantId,
      input.userId,
    );

    const token =
      createVerificationToken();
    const hashedToken =
      await hashVerificationToken(
        token,
      );
    const expiresAt =
      addMilliseconds(
        new Date(),
        EMAIL_VERIFICATION_EXPIRES_IN_MS,
      );

    await verificationRepository.createEmailToken(
      {
        tenantId,
        userId: input.userId,
        hashedToken,
        expiresAt,
      },
    );

    const origin =
      resolveTenantCommerceOrigin({
        tenant: input.tenant,
        requestedOrigin:
          input.requestedOrigin,
      });
    const routeLocale =
      normalizeVerificationLocale(
        input.locale ??
          input.tenant.settings
            ?.publicDefaultLanguage ??
          input.tenant.settings
            ?.defaultLanguage,
      );
    const verificationUrl =
      buildEmailVerificationUrl({
        baseUrl: origin,
        token,
        locale: routeLocale,
        next: input.next,
      });

    await sendEmail({
      tenantId,
      ...buildVerificationEmail({
        email: user.email,
        verificationUrl,
        studioName:
          getStudioName(
            input.tenant,
          ),
        locale:
          resolveCommunicationContentLocale(
            routeLocale,
          ),
      }),
    });

    logger.info(
      {
        tenantId,
        userId: String(
          input.userId,
        ),
      },
      "Verification email sent.",
    );

    return {
      sent: true,
      expiresAt,
    };
  },

  async requestVerificationEmail(input: {
    tenant: VerificationTenant;
    email: string;
    requestedOrigin?: string;
    next?: string;
    locale?: RolloutEligibleAppLocale;
  }) {
    const tenantId = getTenantId(
      input.tenant,
    );
    const email = input.email
      .trim()
      .toLowerCase();

    if (!tenantId) {
      return {
        sent: false,
      };
    }

    const user =
      await UserModel.findOne({
        tenant:
          toObjectId(tenantId),
        email,
      })
        .select(
          "_id email isEmailVerified",
        )
        .exec();

    if (
      !user ||
      user.isEmailVerified === true
    ) {
      return {
        sent: false,
      };
    }

    return this.sendVerificationEmail(
      {
        tenant: input.tenant,
        userId: user._id,
        email: user.email,
        requestedOrigin:
          input.requestedOrigin,
        next: input.next,
        locale: input.locale,
      },
    );
  },

  async verifyEmail(
    input: VerifyEmailInput,
  ) {
    const hashedToken =
      await hashVerificationToken(
        input.token,
      );
    const session =
      await mongoose.startSession();
    let verifiedUserId = "";

    try {
      await session.withTransaction(
        async () => {
          const tokenRecord =
            await verificationRepository.consumePendingEmailToken(
              {
                tenantId:
                  input.tenantId,
                hashedToken,
                now: new Date(),
                session,
              },
            );

          /*
           * A wrong hash leaves the legitimate pending record untouched.
           * This prevents an attacker from invalidating somebody else's link.
           */
          if (!tokenRecord) {
            rejectInvalidVerification();
          }

          const result =
            await UserModel.updateOne(
              {
                _id:
                  tokenRecord.user,
                tenant:
                  toObjectId(
                    input.tenantId,
                  ),
              },
              {
                $set: {
                  isEmailVerified: true,
                },
              },
            )
              .session(session)
              .exec();

          if (
            result.matchedCount !==
            1
          ) {
            rejectInvalidVerification();
          }

          verifiedUserId =
            String(
              tokenRecord.user,
            );
        },
      );
    } finally {
      await session.endSession();
    }

    return {
      verified: true,
      userId: verifiedUserId,
    };
  },

  async resendVerificationEmail(
    input: SendVerificationEmailInput,
  ) {
    return this.sendVerificationEmail(
      input,
    );
  },

  async sendRegistrationConfirmationEmail(
    input: SendRegistrationConfirmationInput,
  ) {
    await sendEmail({
      tenantId: input.tenantId,
      ...buildRegistrationConfirmationEmail(
        input,
      ),
    });

    return {
      email: input.email,
      customId: input.customId,
      memberNumber:
        Number.isSafeInteger(input.memberNumber) && Number(input.memberNumber) > 0
          ? input.memberNumber
          : null,
    };
  },
};

