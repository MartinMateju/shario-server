import crypto from "node:crypto";

import {
  PASSWORD_RESET_OTP_LENGTH,
  PASSWORD_RESET_TOKEN_BYTES,
} from "./password-reset.constants.js";

export const generateNumericOtp = (
  length = PASSWORD_RESET_OTP_LENGTH,
): string => {
  let otp = "";

  for (let index = 0; index < length; index += 1) {
    otp += String(crypto.randomInt(0, 10));
  }

  return otp;
};

export const createOtpToken = (): string => {
  return crypto
    .randomBytes(PASSWORD_RESET_TOKEN_BYTES)
    .toString("hex");
};

export const hashPasswordResetToken = (
  token: string,
): string =>
  crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
