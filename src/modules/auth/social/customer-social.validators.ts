import { z } from "zod";

import { TENANT_SLUG_REGEX } from "@/modules/tenants/tenant.validators.js";
import {
  DEFAULT_APP_LOCALE,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

import {
  CUSTOMER_SOCIAL_ALLOWED_NEXT_PATHS,
  CUSTOMER_SOCIAL_PROVIDERS,
} from "./customer-social.constants.js";

export const customerSocialProviderSchema = z.enum(
  CUSTOMER_SOCIAL_PROVIDERS,
);

const tenantSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(TENANT_SLUG_REGEX);

const rolloutEligibleLocaleSchema = z.preprocess(
  (value) => normalizeRolloutEligibleAppLocale(value) ?? value,
  z.enum(ROLLOUT_ELIGIBLE_APP_LOCALES),
);

export const normalizeCustomerSocialNext = (
  value: unknown,
): string => {
  const candidate =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "/portal";

  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001F\u007F]/.test(candidate)
  ) {
    return "/portal";
  }

  let parsed: URL;

  try {
    parsed = new URL(candidate, "https://customer.shario.invalid");
  } catch {
    return "/portal";
  }

  if (
    parsed.origin !== "https://customer.shario.invalid" ||
    !CUSTOMER_SOCIAL_ALLOWED_NEXT_PATHS.some(
      (path) =>
        parsed.pathname === path ||
        parsed.pathname.startsWith(`${path}/`),
    )
  ) {
    return "/portal";
  }

  return `${parsed.pathname}${parsed.search}`;
};

export const customerSocialProvidersQuerySchema = z
  .object({
    tenantSlug: tenantSlugSchema,
  })
  .strict();

export const customerSocialStartQuerySchema = z
  .object({
    tenantSlug: tenantSlugSchema,
    locale: rolloutEligibleLocaleSchema.default(DEFAULT_APP_LOCALE),
    next: z.string().trim().max(2_000).optional(),
    returnOrigin: z.string().trim().url().max(2_000).optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    next: normalizeCustomerSocialNext(input.next),
  }));

export const customerSocialCallbackSchema = z
  .object({
    state: z.string().trim().min(20).max(8_000),
    code: z.string().trim().min(1).max(8_000).optional(),
    error: z.string().trim().max(200).optional(),
  })
  .passthrough();
