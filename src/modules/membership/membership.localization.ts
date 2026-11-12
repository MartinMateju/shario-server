import { Schema } from "mongoose";

import { resolveTenantLocaleSettings } from "@/modules/tenants/tenant-locale.js";
import { normalizeRolloutEligibleAppLocale, ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import { badRequest } from "@/shared/http/httpErrors.js";

export type MembershipTextTranslation = { name?: string; description?: string; terms?: string };
export type MembershipBenefitTranslation = { label?: string };
export type MembershipTranslations<T> = Partial<Record<(typeof ROLLOUT_ELIGIBLE_APP_LOCALES)[number], T>>;

const textTranslationSchema = new Schema({
  name: { type: String, trim: true, maxlength: 160 },
  description: { type: String, trim: true, maxlength: 2000 },
  terms: { type: String, trim: true, maxlength: 10_000 },
}, { _id: false, strict: true });
const benefitTranslationSchema = new Schema({
  label: { type: String, trim: true, maxlength: 120 },
}, { _id: false, strict: true });

const translationMapField = (schema: Schema) => ({
  type: Map,
  of: schema,
  default: undefined,
  validate: {
    validator: (value: unknown) => Object.keys(plainMembershipTranslations(value)).every(
      (locale) => ROLLOUT_ELIGIBLE_APP_LOCALES.includes(locale as any),
    ),
    message: "Membership translations must use supported language codes.",
  },
});

export const membershipTranslationsField = () => translationMapField(textTranslationSchema);
export const membershipBenefitTranslationsField = () => translationMapField(benefitTranslationSchema);

/** Mongoose Map and lean/JSON documents have the same public wire shape. */
export const plainMembershipTranslations = (value: any): Record<string, any> => {
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
  return Object.fromEntries(entries.map(([locale, text]) => [
    locale,
    typeof text?.toObject === "function" ? text.toObject() : { ...text },
  ]));
};

export const membershipLocalizedText = (content: any, field: string, locale: unknown): string => {
  const key = normalizeRolloutEligibleAppLocale(locale);
  if (key && key === content?.sourceLanguage) return String(content?.[field] ?? "");
  const translation = key ? plainMembershipTranslations(content?.translations)[key]?.[field] : undefined;
  return typeof translation === "string" && translation.trim() ? translation.trim() : String(content?.[field] ?? "");
};

/** Preserve previously authored text if a tenant later disables its language. */
export const assertMembershipTranslationLanguages = (tenant: any, config: any, previous?: any): void => {
  const enabled = new Set(resolveTenantLocaleSettings(tenant.settings).supportedPublicLanguages);
  if (config.sourceLanguage && !enabled.has(config.sourceLanguage) && config.sourceLanguage !== previous?.sourceLanguage) {
    badRequest({ message: "Choose an enabled studio language for membership content.", code: "MEMBERSHIP_TRANSLATION_LANGUAGE_NOT_ENABLED" });
  }
  const check = (translations: any, existing: any, previousBase?: any) => {
    const old = plainMembershipTranslations(existing);
    for (const [locale, translation] of Object.entries(plainMembershipTranslations(translations))) {
      if (enabled.has(locale as any)) continue;
      const previousTranslation = old[locale];
      const keys = Object.keys(translation).sort();
      if (previousTranslation && keys.length === Object.keys(previousTranslation).length &&
          keys.every((key) => translation[key] === previousTranslation[key])) continue;
      // Moving the base language may retain its exact previous text even after
      // that language is removed from the tenant's selected pair.
      if (locale === previous?.sourceLanguage && previousBase &&
          keys.every((key) => translation[key] === (previousBase[key] ?? ""))) continue;
      badRequest({ message: "Enable this language in the studio settings before adding membership translations.", code: "MEMBERSHIP_TRANSLATION_LANGUAGE_NOT_ENABLED" });
    }
  };
  check(config.translations, previous?.translations, previous);
  for (const benefit of config.benefits ?? []) {
    const previousBenefit = previous?.benefits?.find((item: any) => item.key === benefit.key);
    check(benefit.translations, previousBenefit?.translations, previousBenefit);
  }
};
