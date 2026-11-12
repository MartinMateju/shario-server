import { badRequest } from "@/shared/http/httpErrors.js";

import {
  CUSTOMER_SOCIAL_PROVIDER,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";

const value = (key: string): string =>
  String(process.env[key] ?? "").trim();

const redirectUri = (
  provider: CustomerSocialProvider,
  configured: string,
): string => {
  if (configured) return configured;

  const serverUrl = value("SERVER_URL");

  if (!serverUrl) {
    return "";
  }

  return new URL(
    `/auth/customer/social/${provider}/callback`,
    serverUrl,
  ).toString();
};

export type GoogleCustomerSocialConfig = {
  provider: typeof CUSTOMER_SOCIAL_PROVIDER.GOOGLE;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type AppleCustomerSocialConfig = {
  provider: typeof CUSTOMER_SOCIAL_PROVIDER.APPLE;
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  redirectUri: string;
};

export type CustomerSocialProviderConfig =
  | GoogleCustomerSocialConfig
  | AppleCustomerSocialConfig;

export const getCustomerSocialProviderAvailability = () => {
  const hasStateSecret =
    value("CUSTOMER_SOCIAL_STATE_SECRET").length >= 32;

  return {
    google:
      hasStateSecret &&
      Boolean(
        value("GOOGLE_OAUTH_CLIENT_ID") &&
          value("GOOGLE_OAUTH_CLIENT_SECRET") &&
          redirectUri(
            CUSTOMER_SOCIAL_PROVIDER.GOOGLE,
            value("GOOGLE_OAUTH_REDIRECT_URI"),
          ),
      ),
    apple:
      hasStateSecret &&
      Boolean(
        value("APPLE_OAUTH_CLIENT_ID") &&
          value("APPLE_OAUTH_TEAM_ID") &&
          value("APPLE_OAUTH_KEY_ID") &&
          value("APPLE_OAUTH_PRIVATE_KEY") &&
          redirectUri(
            CUSTOMER_SOCIAL_PROVIDER.APPLE,
            value("APPLE_OAUTH_REDIRECT_URI"),
          ),
      ),
  };
};

export const getCustomerSocialProviderConfig = (
  provider: CustomerSocialProvider,
): CustomerSocialProviderConfig => {
  const availability =
    getCustomerSocialProviderAvailability();

  if (!availability[provider]) {
    badRequest({
      message: "This customer sign-in provider is unavailable.",
      code: "CUSTOMER_SOCIAL_PROVIDER_UNAVAILABLE",
    });
  }

  if (provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE) {
    return {
      provider,
      clientId: value("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: value("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirectUri: redirectUri(
        provider,
        value("GOOGLE_OAUTH_REDIRECT_URI"),
      ),
    };
  }

  return {
    provider,
    clientId: value("APPLE_OAUTH_CLIENT_ID"),
    teamId: value("APPLE_OAUTH_TEAM_ID"),
    keyId: value("APPLE_OAUTH_KEY_ID"),
    privateKey: value("APPLE_OAUTH_PRIVATE_KEY"),
    redirectUri: redirectUri(
      provider,
      value("APPLE_OAUTH_REDIRECT_URI"),
    ),
  };
};
