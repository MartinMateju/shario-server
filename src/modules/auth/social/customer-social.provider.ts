import {
  SignJWT,
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
} from "jose";

import { unauthorized } from "@/shared/http/httpErrors.js";

import {
  CUSTOMER_SOCIAL_PROVIDER,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";
import {
  getCustomerSocialProviderConfig,
  type AppleCustomerSocialConfig,
  type CustomerSocialProviderConfig,
} from "./customer-social.config.js";

const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL =
  "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

const APPLE_AUTHORIZE_URL =
  "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
const appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));

export type VerifiedCustomerSocialProfile = {
  provider: CustomerSocialProvider;
  subject: string;
  email: string;
  emailVerified: true;
  firstname: string;
  lastname: string;
};

const verifiedEmail = (value: unknown): boolean =>
  value === true || value === "true";

const normalizeEmail = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase();

const safeName = (value: unknown): string =>
  String(value ?? "").trim().slice(0, 80);

const parseAppleName = (
  value: unknown,
): { firstname: string; lastname: string } => {
  if (typeof value !== "string" || !value || value.length > 10_000) {
    return { firstname: "", lastname: "" };
  }

  try {
    const parsed = JSON.parse(value) as {
      name?: {
        firstName?: unknown;
        lastName?: unknown;
      };
    };

    return {
      firstname: safeName(parsed.name?.firstName),
      lastname: safeName(parsed.name?.lastName),
    };
  } catch {
    return { firstname: "", lastname: "" };
  }
};

const normalizeApplePrivateKey = (raw: string): string => {
  const withNewlines = raw.replaceAll("\\n", "\n").trim();

  if (withNewlines.includes("BEGIN PRIVATE KEY")) {
    return withNewlines;
  }

  const decoded = Buffer.from(withNewlines, "base64").toString("utf8");

  return decoded.includes("BEGIN PRIVATE KEY")
    ? decoded
    : withNewlines;
};

const createAppleClientSecret = async (
  config: AppleCustomerSocialConfig,
): Promise<string> => {
  const privateKey = await importPKCS8(
    normalizeApplePrivateKey(config.privateKey),
    "ES256",
  );
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({
      alg: "ES256",
      kid: config.keyId,
    })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(privateKey);
};

export const buildCustomerSocialAuthorizationUrl = ({
  config,
  state,
  nonce,
  codeChallenge,
}: {
  config: CustomerSocialProviderConfig;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string => {
  const url = new URL(
    config.provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE
      ? GOOGLE_AUTHORIZE_URL
      : APPLE_AUTHORIZE_URL,
  );
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (config.provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE) {
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("prompt", "select_account");
  } else {
    url.searchParams.set("scope", "name email");
    url.searchParams.set("response_mode", "form_post");
  }

  return url.toString();
};

const exchangeCode = async ({
  config,
  code,
  codeVerifier,
}: {
  config: CustomerSocialProviderConfig;
  code: string;
  codeVerifier: string;
}): Promise<string> => {
  const clientSecret =
    config.provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE
      ? config.clientSecret
      : await createAppleClientSecret(config);
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });
  const response = await fetch(
    config.provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE
      ? GOOGLE_TOKEN_URL
      : APPLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (
    !response.ok ||
    typeof body.id_token !== "string" ||
    !body.id_token
  ) {
    unauthorized({
      message: "Customer social sign-in could not be verified.",
      code: "CUSTOMER_SOCIAL_TOKEN_EXCHANGE_FAILED",
    });
  }

  return String(body.id_token);
};

export const verifyCustomerSocialCode = async ({
  provider,
  code,
  nonce,
  codeVerifier,
  appleUser,
}: {
  provider: CustomerSocialProvider;
  code: string;
  nonce: string;
  codeVerifier: string;
  appleUser?: unknown;
}): Promise<VerifiedCustomerSocialProfile> => {
  const config = getCustomerSocialProviderConfig(provider);
  const idToken = await exchangeCode({
    config,
    code,
    codeVerifier,
  });
  const verification =
    provider === CUSTOMER_SOCIAL_PROVIDER.GOOGLE
      ? await jwtVerify(idToken, googleJwks, {
          issuer: [...GOOGLE_ISSUERS],
          audience: config.clientId,
          algorithms: ["RS256"],
        })
      : await jwtVerify(idToken, appleJwks, {
          issuer: APPLE_ISSUER,
          audience: config.clientId,
          algorithms: ["RS256"],
        });
  const claims = verification.payload;
  const email = normalizeEmail(claims.email);

  if (
    !claims.sub ||
    String(claims.nonce ?? "") !== nonce ||
    !email ||
    !verifiedEmail(claims.email_verified)
  ) {
    unauthorized({
      message: "Customer social sign-in identity is invalid.",
      code: "CUSTOMER_SOCIAL_IDENTITY_INVALID",
    });
  }

  const appleName =
    provider === CUSTOMER_SOCIAL_PROVIDER.APPLE
      ? parseAppleName(appleUser)
      : { firstname: "", lastname: "" };
  const firstname =
    appleName.firstname ||
    safeName(claims.given_name) ||
    "Studio";
  const lastname =
    appleName.lastname ||
    safeName(claims.family_name) ||
    "Customer";

  return {
    provider,
    subject: String(claims.sub),
    email,
    emailVerified: true,
    firstname,
    lastname,
  };
};
