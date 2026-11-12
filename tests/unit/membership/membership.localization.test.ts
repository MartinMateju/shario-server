import { describe, expect, it } from "vitest";
import {
  assertMembershipTranslationLanguages,
  membershipLocalizedText,
  plainMembershipTranslations,
} from "@/modules/membership/membership.localization.js";

describe("membership text localization", () => {
  const tenant = { settings: { publicDefaultLanguage: "cs", supportedPublicLanguages: ["cs", "en"] } };

  it("uses translated text and falls back to unchanged primary text for missing or blank translations", () => {
    const content = { name: "Členství", description: "Popis", translations: new Map([["en", { name: "Membership", description: " " }]]) };
    expect(membershipLocalizedText(content, "name", "en")).toBe("Membership");
    expect(membershipLocalizedText(content, "description", "en")).toBe("Popis");
    expect(membershipLocalizedText(content, "name", "cs")).toBe("Členství");
    expect(membershipLocalizedText(content, "name", "unsupported")).toBe("Členství");
    expect(plainMembershipTranslations(content.translations)).toEqual({ en: { name: "Membership", description: " " } });
  });

  it("allows selected secondary-language plan and benefit text", () => {
    expect(() => assertMembershipTranslationLanguages(tenant, { translations: { en: { name: "Membership" } }, benefits: [{ key: "hours", translations: { en: { label: "Hours" } } }] })).not.toThrow();
  });

  it("treats the saved source language's base text as canonical", () => {
    expect(membershipLocalizedText({ sourceLanguage: "en", name: "Updated", translations: { en: { name: "Stale" } } }, "name", "en")).toBe("Updated");
  });

  it("only allows an enabled new source language or unchanged existing source language", () => {
    expect(() => assertMembershipTranslationLanguages(tenant, { sourceLanguage: "en" })).not.toThrow();
    expect(() => assertMembershipTranslationLanguages(tenant, { sourceLanguage: "de" }, { sourceLanguage: "de" })).not.toThrow();
    expect(() => assertMembershipTranslationLanguages(tenant, { sourceLanguage: "de" }, { sourceLanguage: "cs" })).toThrow();
  });

  it("does not allow disabled benefit translations to be carried to a different benefit", () => {
    const previous = { benefits: [{ key: "hours", translations: { de: { label: "Stunden" } } }] };
    expect(() => assertMembershipTranslationLanguages(tenant, previous, previous)).not.toThrow();
    expect(() => assertMembershipTranslationLanguages(tenant, { benefits: [{ key: "coffee", translations: { de: { label: "Stunden" } } }] }, previous)).toThrow();
    expect(() => assertMembershipTranslationLanguages(tenant, { benefits: [{ key: "hours", translations: { de: { label: "Neu" } } }] }, previous)).toThrow();
  });
});
