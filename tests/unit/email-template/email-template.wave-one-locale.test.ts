import { describe, expect, it } from "vitest";

import {
  normalizeEmailLocale,
  selectLocalizedEmailContent,
} from "@/modules/email-template/email-template.rendering.js";

describe("email-template rollout fallback", () => {
  it.each([
    "de",
    "pl-PL",
    "sk",
    "da-DK",
    "fr-FR",
    "es-ES",
    "it-IT",
    "pt_PT",
    "sv-SE",
    "no_NO",
    "nb-NO",
    "fi-FI",
    "hu-HU",
    "el-GR",
    "tr-TR",
    "nl-NL",
    "nl_NL",
    "ro-RO",
    "ro_RO",
  ])(
    "selects English content for %s",
    (locale) => {
      expect(normalizeEmailLocale(locale)).toBe("en");
      expect(
        selectLocalizedEmailContent(
          {
            defaultLocale: "cs",
            contentVariants: {
              cs: { subject: "Česky", body: "Český obsah" },
              en: { subject: "English", body: "English content" },
            },
          },
          locale,
        ),
      ).toMatchObject({
        locale: "en",
        subject: "English",
        body: "English content",
      });
    },
  );

  it("retains the historical Czech fallback for an invalid stored value", () => {
    expect(normalizeEmailLocale("not-a-locale")).toBe("cs");
    expect(normalizeEmailLocale("ja-JP")).toBe("cs");
    expect(normalizeEmailLocale("nn-NO")).toBe("cs");
  });
});

