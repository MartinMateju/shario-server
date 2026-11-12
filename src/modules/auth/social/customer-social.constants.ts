export const CUSTOMER_SOCIAL_PROVIDER = {
  GOOGLE: "google",
  APPLE: "apple",
} as const;

export const CUSTOMER_SOCIAL_PROVIDERS = Object.values(
  CUSTOMER_SOCIAL_PROVIDER,
);

export type CustomerSocialProvider =
  (typeof CUSTOMER_SOCIAL_PROVIDER)[keyof typeof CUSTOMER_SOCIAL_PROVIDER];

export const CUSTOMER_SOCIAL_STATE_TTL_MS = 10 * 60 * 1000;

export const CUSTOMER_SOCIAL_ALLOWED_NEXT_PATHS = [
  "/book",
  "/courses",
  "/memberships",
  "/help",
  "/portal",
] as const;

export const CUSTOMER_SOCIAL_ERROR = {
  ACCESS_DENIED: "access_denied",
  ACCOUNT_CONFLICT: "account_conflict",
  AUTHENTICATION_FAILED: "authentication_failed",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
} as const;
