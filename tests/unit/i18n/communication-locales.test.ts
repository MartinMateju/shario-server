import { describe, expect, it } from "vitest";

import {
  COMMUNICATION_CONTENT_LOCALE,
  getCommunicationIntlLocale,
  resolveCommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

describe("transactional communication locale fallback", () => {
  it.each([
    "en",
    "de",
    "de-DE",
    "pl",
    "sk-SK",
    "da-DK",
    "fr-FR",
    "es-ES",
    "it-IT",
    "pt_PT",
    "sv-SE",
    "nb-NO",
    "no-NO",
    "fi-FI",
    "hu-HU",
    "el-GR",
    "tr-TR",
    "nl-NL",
    "nl_NL",
    "ro-RO",
    "ro_RO",
  ])("uses authored English copy for rollout locale %s", (locale) => {
    expect(resolveCommunicationContentLocale(locale)).toBe("en");
  });

  it.each(["cs", "cz", "CS", "cs-CZ"])(
    "preserves authored Czech copy for alias %s",
    (locale) => {
      expect(resolveCommunicationContentLocale(locale)).toBe("cs");
    },
  );

  it("keeps unknown-locale fallback explicit for legacy callers", () => {
    expect(resolveCommunicationContentLocale("ja")).toBe("en");
    expect(
      resolveCommunicationContentLocale(
        undefined,
        COMMUNICATION_CONTENT_LOCALE.CS,
      ),
    ).toBe("cs");
  });

  it("uses formatting locales that match the selected copy", () => {
    expect(getCommunicationIntlLocale("en")).toBe("en-GB");
    expect(getCommunicationIntlLocale("cs")).toBe("cs-CZ");
  });
});
