import { badRequest, notFound } from "../../../shared/http/httpErrors.js";
import { logger } from "../../../config/logger.js";
import { normalizeEmail } from "../auth.utils.js";
import UserModel from "@/modules/user/user.model.js";
import bcrypt from "bcryptjs";

import type {
  AuthTenantForToken,
  PasswordResetInput,
  PasswordResetRequestInput,
  VerifyOtpInput,
} from "../auth.types.js";

const OTP_TTL_MS = 15 * 60 * 1000;
const RESET_SALT_ROUNDS = 12;

const toId = (value: unknown): string => String(value ?? "");

const createOtp = (): string => {
  return String(Math.floor(100000 + Math.random() * 900000));
};

const hashOtp = (otp: string): Promise<string> => {
  return bcrypt.hash(otp, RESET_SALT_ROUNDS);
};

const verifyOtpHash = (otp: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(otp, hash);
};

export const requestPasswordReset = async ({
  input,
  tenant,
}: {
  input: PasswordResetRequestInput;
  tenant: AuthTenantForToken;
}) => {
  const tenantId = toId(tenant._id || tenant.id);
  const email = normalizeEmail(input.email);

  const user = await UserModel.findOne({
    tenant: tenantId,
    email,
  }).exec();

  if (!user) {
    logger.info(
      { email, tenantId },
      "Password reset requested for non-existing user.",
    );

    return { status: "PENDING" as const };
  }

  const otp = createOtp();
  const otpHash = await hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await UserModel.updateOne(
    {
      _id: user._id,
      tenant: tenantId,
    },
    {
      $set: {
        passwordResetOtpHash: otpHash,
        passwordResetOtpExpiresAt: expiresAt,
      },
    },
  ).exec();

  logger.info(
    { userId: String(user._id), tenantId, expiresAt },
    "Password reset OTP created. Connect email delivery here.",
  );

  return { status: "PENDING" as const };
};

export const verifyPasswordResetOtp = async ({
  input,
  tenant,
}: {
  input: VerifyOtpInput;
  tenant: AuthTenantForToken;
}) => {
  const tenantId = toId(tenant._id || tenant.id);
  const email = normalizeEmail(input.email);

  const user = await UserModel.findOne({
    tenant: tenantId,
    email,
  })
    .select("+passwordResetOtpHash +passwordResetOtpExpiresAt")
    .exec();

  if (!user) {
    notFound("User not found.");
  }

  const otpHash = user.passwordResetOtpHash;
  const expiresAt = user.passwordResetOtpExpiresAt;

  if (!otpHash || !expiresAt || expiresAt.getTime() < Date.now()) {
    badRequest("Password reset code is invalid or expired.");
  }

  const isValid = await verifyOtpHash(input.otp, otpHash);

  if (!isValid) {
    badRequest("Password reset code is invalid or expired.");
  }

  return { status: "VERIFIED" as const };
};

export const resetPasswordWithOtp = async ({
  input,
  tenant,
}: {
  input: PasswordResetInput;
  tenant: AuthTenantForToken;
}) => {
  await verifyPasswordResetOtp({ input, tenant });

  const tenantId = toId(tenant._id || tenant.id);
  const email = normalizeEmail(input.email);

  const user = await UserModel.findOne({
    tenant: tenantId,
    email,
  })
    .select("+password")
    .exec();

  if (!user) {
    notFound("User not found.");
  }

  user.password = input.password;
  user.refreshToken = [];
  user.passwordResetOtpHash = undefined;
  user.passwordResetOtpExpiresAt = undefined;

  await user.save();

  return { status: "VERIFIED" as const };
};