import { describe, expect, it } from "vitest";

import { WORKSPACE_PREFERENCE_LANGUAGE } from "@/modules/tenant-access/tenant-access.constants.js";
import { workspacePreferencesInputSchema } from "@/modules/tenant-access/tenant-access.validators.js";

describe("workspace locale preferences", () => {
  it("keeps the exported preference type aligned with the rollout contract", () => {
    expect(Object.values(WORKSPACE_PREFERENCE_LANGUAGE)).toEqual([
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
  });

  it.each([
    ["CZ", "cs"],
    ["EN", "en"],
    ["de-DE", "de"],
    ["pl-PL", "pl"],
    ["sk-SK", "sk"],
    ["da-DK", "da"],
    ["fr-FR", "fr"],
    ["es-ES", "es"],
    ["it-IT", "it"],
    ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ])("normalizes %s to %s", (input, expected) => {
    const parsed = workspacePreferencesInputSchema.parse({ language: input });

    expect(parsed.language).toBe(expected);
  });

  it("keeps null as the explicit inherit-tenant value", () => {
    expect(
      workspacePreferencesInputSchema.parse({ language: null }).language,
    ).toBeNull();
  });

  it.each(["ja-JP", "nn-NO", "pt-BR"])(
    "does not accept the non-rollout locale %s",
    (language) => {
      expect(
        workspacePreferencesInputSchema.safeParse({ language }).success,
      ).toBe(false);
    },
  );
});
