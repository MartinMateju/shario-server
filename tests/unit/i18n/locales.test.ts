import { describe, expect, it } from "vitest";

import {
  ALL_APP_LOCALES,
  CORE_APP_LOCALES,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  WAVE_ONE_APP_LOCALES,
  WAVE_TWO_A_APP_LOCALES,
  WAVE_TWO_B_APP_LOCALES,
  WAVE_TWO_C_APP_LOCALES,
  WAVE_TWO_D_APP_LOCALES,
  WAVE_TWO_E_APP_LOCALES,
  WAVE_TWO_PLANNED_APP_LOCALES,
  normalizeAppLocale,
  normalizeRolloutEligibleAppLocale,
  normalizeRolloutEligibleAppLocaleList,
  resolveRolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

describe("locale contract", () => {
  it("publishes Wave 1 and every Wave 2 group as rollout eligible", () => {
    expect(CORE_APP_LOCALES).toEqual(["en", "cs"]);
    expect(WAVE_ONE_APP_LOCALES).toEqual(["de", "pl", "sk", "da"]);
    expect(WAVE_TWO_A_APP_LOCALES).toEqual(["fr", "es", "it", "pt-PT"]);
    expect(WAVE_TWO_B_APP_LOCALES).toEqual(["sv", "nb", "fi"]);
    expect(WAVE_TWO_C_APP_LOCALES).toEqual(["hu", "el", "tr"]);
    expect(WAVE_TWO_D_APP_LOCALES).toEqual(["nl"]);
    expect(WAVE_TWO_E_APP_LOCALES).toEqual(["ro"]);
    expect(ROLLOUT_ELIGIBLE_APP_LOCALES).toEqual([
      "en",
      "cs",
      "de",
      "pl",
      "sk",
      "da",
      "fr",
      "es",
      "it",
      "pt-PT",
      "sv",
      "nb",
      "fi",
      "hu",
      "el",
      "tr",
      "nl",
      "ro",
    ]);
    expect(WAVE_TWO_PLANNED_APP_LOCALES).toEqual([]);
    expect(ALL_APP_LOCALES).toHaveLength(18);
  });

  it.each([
    ["CZ", "cs"],
    ["cz", "cs"],
    ["cs-CZ", "cs"],
    ["EN", "en"],
    ["en_US", "en"],
    ["de-DE", "de"],
    ["pl-PL", "pl"],
    ["sk-SK", "sk"],
    ["da-DK", "da"],
    ["fr-FR", "fr"],
    ["fr-CA", "fr"],
    ["es-ES", "es"],
    ["es-MX", "es"],
    ["it-IT", "it"],
    ["it-CH", "it"],
    ["pt_PT", "pt-PT"],
    ["pt", "pt-PT"],
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["gr_GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeAppLocale(input)).toBe(expected);
  });

  it("enables Wave 2 previews without reinterpreting unsupported variants", () => {
    expect(normalizeRolloutEligibleAppLocale("fr-FR")).toBe("fr");
    expect(normalizeRolloutEligibleAppLocale("pt_PT")).toBe("pt-PT");
    expect(normalizeRolloutEligibleAppLocale("sv-SE")).toBe("sv");
    expect(normalizeRolloutEligibleAppLocale("no-NO")).toBe("nb");
    expect(normalizeRolloutEligibleAppLocale("fi-FI")).toBe("fi");
    expect(normalizeRolloutEligibleAppLocale("hu-HU")).toBe("hu");
    expect(normalizeRolloutEligibleAppLocale("el-GR")).toBe("el");
    expect(normalizeRolloutEligibleAppLocale("tr-TR")).toBe("tr");
    expect(normalizeRolloutEligibleAppLocale("nl-NL")).toBe("nl");
    expect(normalizeRolloutEligibleAppLocale("ro-RO")).toBe("ro");
    expect(normalizeAppLocale("nn-NO")).toBeNull();
    expect(normalizeAppLocale("pt-BR")).toBeNull();
    expect(normalizeAppLocale("not-a-locale")).toBeNull();
  });

  it("uses explicit fallbacks and stable de-duplication", () => {
    expect(resolveRolloutEligibleAppLocale("unknown", "cs")).toBe("cs");
    expect(
      normalizeRolloutEligibleAppLocaleList([
        "CZ",
        "cs-CZ",
        "EN",
        "de-DE",
        "fr-FR",
        "pt_PT",
        "no-NO",
        "fi-FI",
        "hu",
        "el-GR",
        "tr_TR",
        "nl_NL",
        "ro_RO",
      ]),
    ).toEqual([
      "cs",
      "en",
      "de",
      "fr",
      "pt-PT",
      "nb",
      "fi",
      "hu",
      "el",
      "tr",
      "nl",
      "ro",
    ]);
  });
});
