export const VERIFICATION_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  EXPIRED: "expired",
  FAILED: "failed",
} as const;

export type VerificationStatus =
  (typeof VERIFICATION_STATUS)[keyof typeof VERIFICATION_STATUS];

export const VERIFICATION_PURPOSE = {
  EMAIL_VERIFICATION: "email_verification",
} as const;

export type VerificationPurpose =
  (typeof VERIFICATION_PURPOSE)[keyof typeof VERIFICATION_PURPOSE];

export const EMAIL_VERIFICATION_EXPIRES_IN_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_VERIFICATION_FROM_EMAIL =
  process.env.AUTH_EMAIL || "no-reply@shario.io";
export const DEFAULT_REGISTRATION_VIDEO_URL =
  "https://youtu.be/d7F0c5cfVpc?si=_52jIS3CKnB_vTlS";
export const DEFAULT_STUDIO_RULES_URL =
  process.env.STUDIO_RULES_URL || "https://app.shario.io/rules";
