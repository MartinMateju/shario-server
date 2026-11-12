export const REFRESH_TOKEN_COOKIE_NAME = "jwt";
export const CUSTOMER_REFRESH_TOKEN_COOKIE_NAME = "customer_jwt";

export const AUTH_CONTEXT = {
  WORKSPACE: "workspace",
  CUSTOMER: "customer",
} as const;

export type AuthContext =
  (typeof AUTH_CONTEXT)[keyof typeof AUTH_CONTEXT];

export const ACCESS_TOKEN_EXPIRES_IN = "50m";
export const REFRESH_TOKEN_EXPIRES_IN = "7d";

export const REFRESH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Prevent abandoned browser sessions from growing the user document without
 * bound. The newest sessions are retained when the cap is reached.
 */
export const REFRESH_TOKEN_SESSION_LIMIT = 10;

export const AUTH_ERROR_MESSAGE = {
  TENANT_REQUIRED: "Tenant context is required.",
  INVALID_CREDENTIALS: "Invalid email or password.",
  ACCESS_DISABLED: "Access to this account has been disabled.",
  EMAIL_PASSWORD_REQUIRED: "Email and password are required.",
  REFRESH_TOKEN_REQUIRED: "Refresh token is required.",
  INVALID_REFRESH_TOKEN: "Invalid refresh token.",
} as const;

export const PASSWORD_RESET_STATUS = {
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
} as const;

export const COOKIE_DOMAINS = Object.fromEntries(
  (process.env.AUTH_COOKIE_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
    .map((domain) => [domain, `.${domain}`]),
) as Record<string, string>;


