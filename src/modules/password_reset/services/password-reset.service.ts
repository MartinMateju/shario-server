import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import { createUserRepository } from "@/modules/user/user.repository.js";
import UserModel from "@/modules/user/user.model.js";
import { unauthorized } from "@/shared/http/httpErrors.js";

import {
  PASSWORD_RESET_BCRYPT_ROUNDS,
  PASSWORD_RESET_OTP_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "../password-reset.constants.js";
import { passwordResetRepository } from "../password-reset.repository.js";
import {
  createOtpToken,
  generateNumericOtp,
  hashPasswordResetToken,
} from "../password-reset.utils.js";

type EmailService = {
  sendOtpEmail(input: {
    tenantId: string;
    to: string;
    otp: string;
    expiresInMinutes: number;
    locale?: "cs" | "en";
    studioName?: string;
  }): Promise<void>;
};

const INVALID_RESET = {
  message:
    "The password reset details are invalid or expired.",
  code: "INVALID_PASSWORD_RESET",
} as const;

/*
 * A missing record still performs a bcrypt comparison so the OTP endpoint
 * does not create a useful account-enumeration timing oracle.
 */
const DUMMY_OTP_HASH =
  "$2a$10$sentsYzVHRvj2zTTqa46IuV2RF5ApQZiXfGzw5Fcx5MF0T1zNf/e2";

const rejectInvalidReset = (): never =>
  unauthorized(INVALID_RESET);

export const createPasswordResetService = (
  emailService: EmailService,
) => {
  return {
    async requestReset(input: {
      tenantId: string;
      email: string;
      locale?: "cs" | "en";
      studioName?: string;
    }): Promise<{ status: "PENDING" }> {
      const userRepository =
        createUserRepository({
          tenantId: input.tenantId,
        });

      const user =
        await userRepository.findByEmail(
          input.email,
        );

      // Never reveal whether an account exists in this tenant.
      if (!user) {
        return {
          status: "PENDING",
        };
      }

      const otp = generateNumericOtp();
      const otpHash = await bcrypt.hash(
        otp,
        PASSWORD_RESET_BCRYPT_ROUNDS,
      );
      const expiresAt = new Date(
        Date.now() +
          PASSWORD_RESET_OTP_TTL_MS,
      );

      await passwordResetRepository.invalidateActiveForUser(
        input.tenantId,
        String(user._id),
      );

      await passwordResetRepository.create({
        tenantId: input.tenantId,
        userId: String(user._id),
        email: user.email,
        otpHash,
        expiresAt,
      });

      await emailService.sendOtpEmail({
        tenantId: input.tenantId,
        to: user.email,
        otp,
        expiresInMinutes: Math.round(
          PASSWORD_RESET_OTP_TTL_MS /
            60_000,
        ),
        locale: input.locale,
        studioName: input.studioName,
      });

      return {
        status: "PENDING",
      };
    },

    async verifyOtp(input: {
      tenantId: string;
      email: string;
      otp: string;
    }): Promise<{
      status: "VERIFIED";
      resetToken: string;
    }> {
      const reset =
        await passwordResetRepository.findLatestPendingByEmail(
          input.tenantId,
          input.email,
        );

      if (!reset) {
        await bcrypt.compare(
          input.otp,
          DUMMY_OTP_HASH,
        );
        rejectInvalidReset();
      }

      const now = new Date();

      if (
        reset.expiresAt.getTime() <=
          now.getTime() ||
        reset.attempts >=
          reset.maxAttempts
      ) {
        await passwordResetRepository.expirePending(
          {
            tenantId: input.tenantId,
            resetId: String(reset._id),
          },
        );
        rejectInvalidReset();
      }

      const isValid = await bcrypt.compare(
        input.otp,
        reset.otpHash,
      );

      if (!isValid) {
        await passwordResetRepository.incrementAttemptsIfPending(
          {
            tenantId: input.tenantId,
            resetId: String(
              reset._id,
            ),
            now,
          },
        );
        rejectInvalidReset();
      }

      const resetToken =
        createOtpToken();
      const resetTokenHash =
        hashPasswordResetToken(
          resetToken,
        );
      const resetTokenExpiresAt =
        new Date(
          Math.min(
            reset.expiresAt.getTime(),
            now.getTime() +
              PASSWORD_RESET_TOKEN_TTL_MS,
          ),
        );

      const verified =
        await passwordResetRepository.verifyPending(
          {
            tenantId: input.tenantId,
            resetId: String(
              reset._id,
            ),
            resetTokenHash,
            resetTokenExpiresAt,
            now,
          },
        );

      /*
       * The conditional transition ensures that two concurrent OTP
       * verifications cannot mint two usable reset tokens.
       */
      if (!verified) {
        rejectInvalidReset();
      }

      return {
        status: "VERIFIED",
        resetToken,
      };
    },

    async resetPassword(input: {
      tenantId: string;
      resetToken: string;
      password: string;
    }): Promise<{
      status: "SUCCESS";
    }> {
      const resetTokenHash =
        hashPasswordResetToken(
          input.resetToken,
        );
      const hashedPassword =
        await bcrypt.hash(
          input.password,
          PASSWORD_RESET_BCRYPT_ROUNDS,
        );
      const session =
        await mongoose.startSession();

      try {
        await session.withTransaction(
          async () => {
            const reset =
              await passwordResetRepository.consumeVerified(
                {
                  tenantId:
                    input.tenantId,
                  resetTokenHash,
                  now: new Date(),
                  session,
                },
              );

            if (!reset) {
              rejectInvalidReset();
            }

            const result =
              await UserModel.updateOne(
                {
                  _id: reset.user,
                  tenant:
                    input.tenantId,
                },
                {
                  $set: {
                    password:
                      hashedPassword,
                    // A password reset revokes every browser session.
                    refreshToken: [],
                  },
                  $inc: {
                    sessionVersion: 1,
                  },
                },
              )
                .session(session)
                .exec();

            if (
              result.matchedCount !==
              1
            ) {
              rejectInvalidReset();
            }

            await passwordResetRepository.invalidateActiveForUser(
              input.tenantId,
              String(reset.user),
              session,
            );
          },
        );
      } finally {
        await session.endSession();
      }

      return {
        status: "SUCCESS",
      };
    },
  };
};
