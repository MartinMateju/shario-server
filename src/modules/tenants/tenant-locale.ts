import {
  APP_LOCALE,
  normalizeRolloutEligibleAppLocale,
  normalizeRolloutEligibleAppLocaleList,
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

export const DEFAULT_TENANT_LOCALE: RolloutEligibleAppLocale = APP_LOCALE.EN;

/** A tenant public site has one primary and at most one secondary language. */
export const MAX_TENANT_PUBLIC_LANGUAGES = 2;

export const LEGACY_TENANT_LANGUAGE = {
  CZ: "CZ",
  EN: "EN",
} as const;

export type LegacyTenantLanguage =
  (typeof LEGACY_TENANT_LANGUAGE)[keyof typeof LEGACY_TENANT_LANGUAGE];

/**
 * Bridge for untouched server consumers that still compare the persisted
 * defaultLanguage value with uppercase CZ/EN. Wave 1 maps to English until
 * those consumers are migrated as one coordinated communication rollout.
 */
export const toLegacyTenantLanguage = (
  value: unknown,
): LegacyTenantLanguage | null => {
  const canonical = normalizeRolloutEligibleAppLocale(value);
  if (!canonical) return null;
  return canonical === APP_LOCALE.CS
    ? LEGACY_TENANT_LANGUAGE.CZ
    : LEGACY_TENANT_LANGUAGE.EN;
};

export type TenantLocaleSettingsInput = {
  /** @deprecated Compatibility alias for publicDefaultLanguage. */
  defaultLanguage?: unknown;
  adminLanguage?: unknown;
  publicDefaultLanguage?: unknown;
  supportedPublicLanguages?: unknown;
};

export type ResolvedTenantLocaleSettings = {
  /** @deprecated Compatibility alias for publicDefaultLanguage. */
  defaultLanguage: LegacyTenantLanguage;
  adminLanguage: RolloutEligibleAppLocale;
  publicDefaultLanguage: RolloutEligibleAppLocale;
  supportedPublicLanguages: RolloutEligibleAppLocale[];
};

/**
 * Produces the canonical public-site language order without discarding an
 * explicitly requested third language. Write paths can inspect the returned
 * length and reject ambiguous input; read paths may safely take the first two
 * values for documents persisted before the two-language limit.
 */
export const normalizeTenantPublicLanguageSelection = ({
  publicDefaultLanguage,
  supportedPublicLanguages,
}: {
  publicDefaultLanguage: RolloutEligibleAppLocale;
  supportedPublicLanguages: unknown;
}): RolloutEligibleAppLocale[] => [
  publicDefaultLanguage,
  ...normalizeRolloutEligibleAppLocaleList(supportedPublicLanguages).filter(
    (locale) => locale !== publicDefaultLanguage,
  ),
];

/**
 * Read-side compatibility for tenants persisted before the canonical locale
 * contract. Canonical fields never leak historical casing; only the explicitly
 * deprecated defaultLanguage bridge remains uppercase for old consumers.
 */
export const resolveTenantLocaleSettings = (
  settings: TenantLocaleSettingsInput | null | undefined,
): ResolvedTenantLocaleSettings => {
  const legacyDefault = resolveRolloutEligibleAppLocale(
    settings?.defaultLanguage,
    DEFAULT_TENANT_LOCALE,
  );
  const adminLanguage = resolveRolloutEligibleAppLocale(
    settings?.adminLanguage,
    legacyDefault,
  );
  const publicDefaultLanguage = resolveRolloutEligibleAppLocale(
    settings?.publicDefaultLanguage,
    legacyDefault,
  );
  const supportedPublicLanguages = normalizeTenantPublicLanguageSelection({
    publicDefaultLanguage,
    supportedPublicLanguages: settings?.supportedPublicLanguages,
  }).slice(0, MAX_TENANT_PUBLIC_LANGUAGES);

  return {
    defaultLanguage:
      toLegacyTenantLanguage(publicDefaultLanguage) ??
      LEGACY_TENANT_LANGUAGE.EN,
    adminLanguage,
    publicDefaultLanguage,
    supportedPublicLanguages,
  };
};
