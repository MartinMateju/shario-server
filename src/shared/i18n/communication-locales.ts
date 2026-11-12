import {
  APP_LOCALE,
  normalizeRolloutEligibleAppLocale,
} from "./locales.js";

/**
 * Languages with authored transactional copy today.
 *
 * Preview route locales remain attached to customer-facing links and persisted
 * delivery metadata. Until translated copy is authored, every non-Czech
 * rollout locale deliberately uses English rather than accidentally falling
 * through to Czech.
 */
export const COMMUNICATION_CONTENT_LOCALE = {
  EN: APP_LOCALE.EN,
  CS: APP_LOCALE.CS,
} as const;

export type CommunicationContentLocale =
  (typeof COMMUNICATION_CONTENT_LOCALE)[keyof typeof COMMUNICATION_CONTENT_LOCALE];

export const resolveCommunicationContentLocale = (
  value: unknown,
  fallback: CommunicationContentLocale = COMMUNICATION_CONTENT_LOCALE.EN,
): CommunicationContentLocale => {
  const locale = normalizeRolloutEligibleAppLocale(value);

  if (locale === APP_LOCALE.CS) return COMMUNICATION_CONTENT_LOCALE.CS;
  if (locale) return COMMUNICATION_CONTENT_LOCALE.EN;

  return fallback;
};

export const getCommunicationIntlLocale = (
  locale: CommunicationContentLocale,
): "cs-CZ" | "en-GB" =>
  locale === COMMUNICATION_CONTENT_LOCALE.CS ? "cs-CZ" : "en-GB";
