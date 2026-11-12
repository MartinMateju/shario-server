import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import {
  badRequest,
  conflict,
} from "@/shared/http/httpErrors.js";
import {
  isRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import CustomerSocialAttemptModel from "./customer-social-attempt.schema.js";
import {
  CUSTOMER_SOCIAL_PROVIDER,
  CUSTOMER_SOCIAL_PROVIDERS,
  CUSTOMER_SOCIAL_STATE_TTL_MS,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";
import { normalizeCustomerSocialNext } from "./customer-social.validators.js";

const VERSION = "v1";
const IV_BYTES = 12;

export type CustomerSocialStatePayload = {
  provider: CustomerSocialProvider;
  tenantId: string;
  tenantSlug: string;
  locale: RolloutEligibleAppLocale;
  next: string;
  returnOrigin: string;
  nonce: string;
  codeVerifier: string;
  stateId: string;
  expiresAt: number;
};

const stateKey = (): Buffer => {
  const secret = String(
    process.env.CUSTOMER_SOCIAL_STATE_SECRET ?? "",
  ).trim();

  if (secret.length < 32) {
    throw new Error(
      "CUSTOMER_SOCIAL_STATE_SECRET must contain at least 32 characters.",
    );
  }

  return createHash("sha256").update(secret, "utf8").digest();
};

const stateIdHash = (stateId: string): string =>
  createHash("sha256").update(stateId, "utf8").digest("hex");

const isProvider = (
  value: unknown,
): value is CustomerSocialProvider =>
  CUSTOMER_SOCIAL_PROVIDERS.includes(
    value as CustomerSocialProvider,
  );

const assertStatePayload = (
  value: unknown,
): CustomerSocialStatePayload => {
  const payload =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  if (
    !isProvider(payload.provider) ||
    !/^[a-f0-9]{24}$/i.test(String(payload.tenantId ?? "")) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(
      String(payload.tenantSlug ?? ""),
    ) ||
    !isRolloutEligibleAppLocale(payload.locale) ||
    !/^https?:\/\/[^/]+$/i.test(String(payload.returnOrigin ?? "")) ||
    !/^[A-Za-z0-9_-]{32,200}$/.test(String(payload.nonce ?? "")) ||
    !/^[A-Za-z0-9_-]{43,200}$/.test(
      String(payload.codeVerifier ?? ""),
    ) ||
    !/^[A-Za-z0-9_-]{32,200}$/.test(String(payload.stateId ?? "")) ||
    !Number.isFinite(payload.expiresAt) ||
    Number(payload.expiresAt) <= Date.now()
  ) {
    badRequest({
      message: "Customer social sign-in state is invalid or expired.",
      code: "CUSTOMER_SOCIAL_STATE_INVALID",
    });
  }

  return {
    provider: payload.provider as CustomerSocialProvider,
    tenantId: String(payload.tenantId),
    tenantSlug: String(payload.tenantSlug),
    locale: payload.locale as RolloutEligibleAppLocale,
    next: normalizeCustomerSocialNext(payload.next),
    returnOrigin: String(payload.returnOrigin),
    nonce: String(payload.nonce),
    codeVerifier: String(payload.codeVerifier),
    stateId: String(payload.stateId),
    expiresAt: Number(payload.expiresAt),
  };
};

export const encryptCustomerSocialState = (
  payload: CustomerSocialStatePayload,
): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
};

export const decryptCustomerSocialState = (
  state: string,
): CustomerSocialStatePayload => {
  try {
    const [version, ivEncoded, tagEncoded, encryptedEncoded] =
      String(state ?? "").split(".");

    if (
      version !== VERSION ||
      !ivEncoded ||
      !tagEncoded ||
      !encryptedEncoded
    ) {
      throw new Error("Malformed state.");
    }

    const iv = Buffer.from(ivEncoded, "base64url");
    const tag = Buffer.from(tagEncoded, "base64url");
    const encrypted = Buffer.from(encryptedEncoded, "base64url");

    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new Error("Malformed state.");
    }

    const decipher = createDecipheriv("aes-256-gcm", stateKey(), iv);
    decipher.setAuthTag(tag);

    const decoded = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");

    return assertStatePayload(JSON.parse(decoded));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "CUSTOMER_SOCIAL_STATE_INVALID"
    ) {
      throw error;
    }

    badRequest({
      message: "Customer social sign-in state is invalid or expired.",
      code: "CUSTOMER_SOCIAL_STATE_INVALID",
    });
  }
};

export const createCustomerSocialState = async (
  input: Omit<
    CustomerSocialStatePayload,
    "nonce" | "codeVerifier" | "stateId" | "expiresAt"
  >,
): Promise<{
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}> => {
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const stateId = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + CUSTOMER_SOCIAL_STATE_TTL_MS;

  await CustomerSocialAttemptModel.create({
    tenant: input.tenantId,
    provider: input.provider,
    stateIdHash: stateIdHash(stateId),
    expiresAt: new Date(expiresAt),
  });

  const state = encryptCustomerSocialState({
    ...input,
    nonce,
    codeVerifier,
    stateId,
    expiresAt,
  });

  return {
    state,
    nonce,
    codeVerifier,
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
  };
};

export const consumeCustomerSocialState = async ({
  state,
  provider,
}: {
  state: string;
  provider: CustomerSocialProvider;
}): Promise<CustomerSocialStatePayload> => {
  const payload = decryptCustomerSocialState(state);

  if (payload.provider !== provider) {
    badRequest({
      message: "Customer social sign-in provider does not match state.",
      code: "CUSTOMER_SOCIAL_STATE_PROVIDER_MISMATCH",
    });
  }

  const consumed = await CustomerSocialAttemptModel.findOneAndDelete({
    tenant: payload.tenantId,
    provider,
    stateIdHash: stateIdHash(payload.stateId),
    expiresAt: { $gt: new Date() },
  })
    .select("+stateIdHash")
    .lean()
    .exec();

  if (!consumed) {
    conflict({
      message: "Customer social sign-in state was already used or expired.",
      code: "CUSTOMER_SOCIAL_STATE_REPLAYED",
    });
  }

  return payload;
};

export const isAppleProvider = (
  provider: CustomerSocialProvider,
): boolean => provider === CUSTOMER_SOCIAL_PROVIDER.APPLE;
