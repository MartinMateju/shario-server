/**
 * Canonical locale contract shared by persistence, APIs and background jobs.
 *
 * Core locales are live today. Wave 1 and Wave 2 locales are accepted by the
 * backend so each tenant can opt into them when the matching client preview is
 * enabled; backend eligibility does not make a locale globally visible.
 * The registry remains ready for future targets without making them live.
 */
export const APP_LOCALE = {
  EN: "en",
  CS: "cs",
  DE: "de",
  PL: "pl",
  SK: "sk",
  DA: "da",
  FR: "fr",
  ES: "es",
  IT: "it",
  PT_PT: "pt-PT",
  SV: "sv",
  NB: "nb",
  FI: "fi",
  HU: "hu",
  EL: "el",
  TR: "tr",
  NL: "nl",
  RO: "ro",
} as const;

export type AppLocale = (typeof APP_LOCALE)[keyof typeof APP_LOCALE];

export const CORE_APP_LOCALES = [APP_LOCALE.EN, APP_LOCALE.CS] as const;

export type CoreAppLocale = (typeof CORE_APP_LOCALES)[number];

export const WAVE_ONE_APP_LOCALES = [
  APP_LOCALE.DE,
  APP_LOCALE.PL,
  APP_LOCALE.SK,
  APP_LOCALE.DA,
] as const;

export type WaveOneAppLocale = (typeof WAVE_ONE_APP_LOCALES)[number];

export const WAVE_TWO_A_APP_LOCALES = [
  APP_LOCALE.FR,
  APP_LOCALE.ES,
  APP_LOCALE.IT,
  APP_LOCALE.PT_PT,
] as const;

export type WaveTwoAAppLocale = (typeof WAVE_TWO_A_APP_LOCALES)[number];

export const WAVE_TWO_B_APP_LOCALES = [
  APP_LOCALE.SV,
  APP_LOCALE.NB,
  APP_LOCALE.FI,
] as const;

export type WaveTwoBAppLocale = (typeof WAVE_TWO_B_APP_LOCALES)[number];

export const WAVE_TWO_C_APP_LOCALES = [
  APP_LOCALE.HU,
  APP_LOCALE.EL,
  APP_LOCALE.TR,
] as const;

export type WaveTwoCAppLocale = (typeof WAVE_TWO_C_APP_LOCALES)[number];

export const WAVE_TWO_D_APP_LOCALES = [APP_LOCALE.NL] as const;

export type WaveTwoDAppLocale = (typeof WAVE_TWO_D_APP_LOCALES)[number];

export const WAVE_TWO_E_APP_LOCALES = [APP_LOCALE.RO] as const;

export type WaveTwoEAppLocale = (typeof WAVE_TWO_E_APP_LOCALES)[number];

export const ROLLOUT_ELIGIBLE_APP_LOCALES = [
  ...CORE_APP_LOCALES,
  ...WAVE_ONE_APP_LOCALES,
  ...WAVE_TWO_A_APP_LOCALES,
  ...WAVE_TWO_B_APP_LOCALES,
  ...WAVE_TWO_C_APP_LOCALES,
  ...WAVE_TWO_D_APP_LOCALES,
  ...WAVE_TWO_E_APP_LOCALES,
] as const;

export type RolloutEligibleAppLocale =
  (typeof ROLLOUT_ELIGIBLE_APP_LOCALES)[number];

export const WAVE_TWO_PLANNED_APP_LOCALES = [] as const;

export type WaveTwoPlannedAppLocale =
  (typeof WAVE_TWO_PLANNED_APP_LOCALES)[number];

export const ALL_APP_LOCALES = [
  ...ROLLOUT_ELIGIBLE_APP_LOCALES,
  ...WAVE_TWO_PLANNED_APP_LOCALES,
] as const satisfies readonly AppLocale[];

export const DEFAULT_APP_LOCALE: RolloutEligibleAppLocale = APP_LOCALE.EN;

const localeByNormalizedTag = new Map<string, AppLocale>(
  ALL_APP_LOCALES.map((locale) => [locale.toLowerCase(), locale]),
);

const primaryLocaleAliases = new Map<string, AppLocale>([
  ["en", APP_LOCALE.EN],
  ["cs", APP_LOCALE.CS],
  ["cz", APP_LOCALE.CS],
  ["de", APP_LOCALE.DE],
  ["pl", APP_LOCALE.PL],
  ["sk", APP_LOCALE.SK],
  ["da", APP_LOCALE.DA],
  ["fr", APP_LOCALE.FR],
  ["es", APP_LOCALE.ES],
  ["it", APP_LOCALE.IT],
  ["sv", APP_LOCALE.SV],
  ["nb", APP_LOCALE.NB],
  ["no", APP_LOCALE.NB],
  ["fi", APP_LOCALE.FI],
  ["hu", APP_LOCALE.HU],
  ["el", APP_LOCALE.EL],
  ["gr", APP_LOCALE.EL],
  ["tr", APP_LOCALE.TR],
  ["nl", APP_LOCALE.NL],
  ["ro", APP_LOCALE.RO],
]);

const rolloutEligibleLocaleSet = new Set<AppLocale>(
  ROLLOUT_ELIGIBLE_APP_LOCALES,
);

/**
 * Normalizes historical values and common BCP-47/browser variants.
 *
 * Unknown values return null instead of silently becoming English. Callers
 * choose their own explicit fallback with resolveRolloutEligibleAppLocale().
 */
export const normalizeAppLocale = (value: unknown): AppLocale | null => {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll("_", "-")
    .toLowerCase();

  if (!normalized) return null;

  if (normalized === "cz-cz") return APP_LOCALE.CS;
  if (normalized === "pt") return APP_LOCALE.PT_PT;
  if (normalized === "pt-pt") return APP_LOCALE.PT_PT;
  // Do not silently reinterpret Brazilian Portuguese as European Portuguese.
  if (normalized.startsWith("pt-")) return null;

  const exact = localeByNormalizedTag.get(normalized);
  if (exact) return exact;

  return primaryLocaleAliases.get(normalized.split("-")[0] ?? "") ?? null;
};

export const normalizeRolloutEligibleAppLocale = (
  value: unknown,
): RolloutEligibleAppLocale | null => {
  const normalized = normalizeAppLocale(value);
  return normalized && rolloutEligibleLocaleSet.has(normalized)
    ? (normalized as RolloutEligibleAppLocale)
    : null;
};

export const resolveRolloutEligibleAppLocale = (
  value: unknown,
  fallback: RolloutEligibleAppLocale = DEFAULT_APP_LOCALE,
): RolloutEligibleAppLocale =>
  normalizeRolloutEligibleAppLocale(value) ?? fallback;

export const normalizeRolloutEligibleAppLocaleList = (
  values: unknown,
): RolloutEligibleAppLocale[] => {
  if (!Array.isArray(values)) return [];

  return [
    ...new Set(
      values
        .map(normalizeRolloutEligibleAppLocale)
        .filter(
          (locale): locale is RolloutEligibleAppLocale => locale !== null,
        ),
    ),
  ];
};

export const isRolloutEligibleAppLocale = (
  value: unknown,
): value is RolloutEligibleAppLocale =>
  normalizeRolloutEligibleAppLocale(value) === value;
