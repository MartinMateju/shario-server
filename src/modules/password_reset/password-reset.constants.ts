export const PASSWORD_RESET_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  USED: "used",
  EXPIRED: "expired",
} as const;

export type PasswordResetStatus =
  (typeof PASSWORD_RESET_STATUS)[keyof typeof PASSWORD_RESET_STATUS];

export const PASSWORD_RESET_OTP_LENGTH = 6;
export const PASSWORD_RESET_OTP_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const PASSWORD_RESET_BCRYPT_ROUNDS = 10;
