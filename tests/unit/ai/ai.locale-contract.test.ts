import { describe, expect, it } from "vitest";

import {
  AI_LOCALE_LANGUAGE_NAME,
  AI_LOCALES,
  aiResponseLanguageInstruction,
  localizedAdvisorFallback,
  localizedAiServiceUnavailable,
  localizedBookingComposerNavigationLabel,
  localizedBriefingFallback,
  localizedDeterministicCopyNotice,
  localizedSetupNavigationLabel,
} from "@/modules/ai/ai-locale.js";
import {
  aiLocaleSchema,
  aiSettingsPatchSchema,
  briefingGenerateSchema,
  briefingLatestQuerySchema,
  businessAdvisorGenerateSchema,
  businessAdvisorRecommendationsQuerySchema,
  createAiConversationSchema,
  customerConciergeSchema,
  knowledgeCoverageQuerySchema,
  publicConciergeSchema,
  sendAiMessageSchema,
} from "@/modules/ai/ai.validators.js";
import { evaluateKnowledgeCoverage } from "@/modules/ai/services/knowledge-coverage.service.js";
import { normalizeKnowledgeLocale } from "@/modules/ai/services/knowledge-retrieval.service.js";
import { normalizeBusinessAdvisorLocale } from "@/modules/ai/services/business-advisor-snapshot.service.js";

const localeCases = [
  ["en-US", "en"],
  ["cs-CZ", "cs"],
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
  ["gr_GR", "el"],
  ["tr-TR", "tr"],
  ["nl-NL", "nl"],
  ["nl_NL", "nl"],
  ["ro-RO", "ro"],
  ["ro_RO", "ro"],
] as const;

describe("AI rollout locale contract", () => {
  it("uses the canonical rollout-eligible locale list", () => {
    expect(AI_LOCALES).toEqual([
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

  it.each(localeCases)(
    "canonicalizes %s across every public and workspace AI request schema",
    (input, expected) => {
      expect(aiLocaleSchema.parse(input)).toBe(expected);
      expect(createAiConversationSchema.parse({ locale: input }).locale).toBe(
        expected,
      );
      expect(
        sendAiMessageSchema.parse({ message: "Hello", locale: input }).locale,
      ).toBe(expected);
      expect(
        publicConciergeSchema.parse({ message: "Hello", locale: input }).locale,
      ).toBe(expected);
      expect(
        customerConciergeSchema.parse({ message: "Hello", locale: input })
          .locale,
      ).toBe(expected);
      expect(knowledgeCoverageQuerySchema.parse({ locale: input }).locale).toBe(
        expected,
      );
      expect(briefingGenerateSchema.parse({ locale: input }).locale).toBe(
        expected,
      );
      expect(briefingLatestQuerySchema.parse({ locale: input }).locale).toBe(
        expected,
      );
      expect(
        businessAdvisorGenerateSchema.parse({ locale: input }).locale,
      ).toBe(expected);
      expect(
        businessAdvisorRecommendationsQuerySchema.parse({ locale: input })
          .locale,
      ).toBe(expected);
      expect(
        aiSettingsPatchSchema.parse({ defaultLocale: input }).defaultLocale,
      ).toBe(expected);
    },
  );

  it.each(localeCases)(
    "maps %s to the provider language and runtime locale",
    (input, expected) => {
      expect(normalizeKnowledgeLocale(input)).toBe(expected);
      expect(normalizeBusinessAdvisorLocale(input)).toBe(expected);
      expect(aiResponseLanguageInstruction(input)).toContain(
        `${AI_LOCALE_LANGUAGE_NAME[expected]} (${expected})`,
      );
      expect(aiResponseLanguageInstruction(input)).toContain(
        "every user-facing string",
      );
    },
  );

  it.each([
    ["en-US", "Open unprefilled New booking form", "Review prefilled booking"],
    [
      "cs-CZ",
      "Otevřít prázdný formulář Nová rezervace",
      "Zkontrolovat předvyplněnou rezervaci",
    ],
    [
      "de-DE",
      "Leeres Formular „Neue Buchung“ öffnen",
      "Vorausgefüllte Buchung prüfen",
    ],
    [
      "pl-PL",
      "Otwórz pusty formularz nowej rezerwacji",
      "Sprawdź wstępnie wypełnioną rezerwację",
    ],
    [
      "sk-SK",
      "Otvoriť prázdny formulár novej rezervácie",
      "Skontrolovať predvyplnenú rezerváciu",
    ],
    ["da-DK", "Åbn tom formular til ny booking", "Gennemgå forudfyldt booking"],
    [
      "fr-FR",
      "Ouvrir le formulaire Nouvelle réservation vide",
      "Vérifier la réservation préremplie",
    ],
    [
      "es-ES",
      "Abrir el formulario Nueva reserva vacío",
      "Revisar la reserva precompletada",
    ],
    [
      "it-IT",
      "Apri il modulo Nuova prenotazione vuoto",
      "Controlla la prenotazione precompilata",
    ],
    [
      "pt_PT",
      "Abrir o formulário Nova reserva em branco",
      "Rever a reserva pré-preenchida",
    ],
    [
      "sv-SE",
      "Öppna ett tomt formulär för ny bokning",
      "Granska förifylld bokning",
    ],
    [
      "no-NO",
      "Åpne et tomt skjema for ny booking",
      "Se gjennom forhåndsutfylt booking",
    ],
    ["fi-FI", "Avaa tyhjä Uusi varaus -lomake", "Tarkista esitäytetty varaus"],
    [
      "hu-HU",
      "Üres Új foglalás űrlap megnyitása",
      "Előre kitöltött foglalás ellenőrzése",
    ],
    [
      "el-GR",
      "Άνοιγμα κενής φόρμας Νέας κράτησης",
      "Έλεγχος προσυμπληρωμένης κράτησης",
    ],
    [
      "tr-TR",
      "Boş yeni rezervasyon formunu aç",
      "Önceden doldurulmuş rezervasyonu gözden geçir",
    ],
    [
      "nl-NL",
      "Een leeg formulier voor een nieuwe boeking openen",
      "Vooraf ingevulde boeking controleren",
    ],
    [
      "ro-RO",
      "Deschide formularul necompletat pentru o rezervare nouă",
      "Verifică rezervarea completată în prealabil",
    ],
  ] as const)(
    "localizes server-owned booking navigation labels for %s",
    (locale, unprefilled, prefilled) => {
      expect(
        localizedBookingComposerNavigationLabel(locale, "unprefilled"),
      ).toBe(unprefilled);
      expect(localizedBookingComposerNavigationLabel(locale, "prefilled")).toBe(
        prefilled,
      );
    },
  );

  it.each([
    ["en-US", "Open recommended setup"],
    ["cs-CZ", "Otevřít doporučené nastavení"],
    ["de-DE", "Empfohlene Einrichtung öffnen"],
    ["pl-PL", "Otwórz zalecaną konfigurację"],
    ["sk-SK", "Otvoriť odporúčané nastavenie"],
    ["da-DK", "Åbn anbefalet opsætning"],
    ["fr-FR", "Ouvrir la configuration recommandée"],
    ["es-ES", "Abrir la configuración recomendada"],
    ["it-IT", "Apri la configurazione consigliata"],
    ["pt_PT", "Abrir a configuração recomendada"],
    ["sv-SE", "Öppna rekommenderad konfiguration"],
    ["no-NO", "Åpne anbefalt oppsett"],
    ["fi-FI", "Avaa suositellut asetukset"],
    ["hu-HU", "Javasolt beállítás megnyitása"],
    ["el-GR", "Άνοιγμα προτεινόμενης ρύθμισης"],
    ["tr-TR", "Önerilen kurulumu aç"],
    ["nl-NL", "Aanbevolen configuratie openen"],
    ["ro-RO", "Deschide configurarea recomandată"],
  ] as const)(
    "localizes the server-owned setup navigation label for %s",
    (locale, expected) => {
      expect(localizedSetupNavigationLabel(locale)).toBe(expected);
    },
  );

  it.each([
    ["sv-SE", "svaret i realtid", "driftuppgifterna"],
    ["no-NO", "KI-sammendraget", "KI-analysen"],
    ["fi-FI", "tällä hetkellä", "tekoälyanalyysi"],
  ] as const)(
    "keeps deterministic Wave 2B fallback copy native for %s",
    (locale, firstPhrase, secondPhrase) => {
      const copy = [
        localizedAiServiceUnavailable(locale),
        localizedDeterministicCopyNotice(locale),
        ...Object.values(localizedBriefingFallback(locale)),
        ...Object.values(localizedAdvisorFallback(locale)),
      ].join(" ");

      expect(copy).toContain(firstPhrase);
      expect(copy).toContain(secondPhrase);
      expect(copy).not.toContain("temporarily unavailable");
    },
  );

  it.each([
    ["hu-HU", "MI-összefoglaló", "MI-elemzés"],
    ["el-GR", "σύνοψη ΤΝ", "ανάλυση ΤΝ"],
    ["tr-TR", "yapay zekâ özeti", "yapay zekâ değerlendirmesi"],
  ] as const)(
    "keeps deterministic Wave 2C fallback copy native for %s",
    (locale, firstPhrase, secondPhrase) => {
      const copy = [
        localizedAiServiceUnavailable(locale),
        localizedDeterministicCopyNotice(locale),
        ...Object.values(localizedBriefingFallback(locale)),
        ...Object.values(localizedAdvisorFallback(locale)),
      ].join(" ");

      expect(copy).toContain(firstPhrase);
      expect(copy).toContain(secondPhrase);
      expect(copy).not.toContain("temporarily unavailable");
    },
  );

  it("keeps deterministic Dutch fallback copy native", () => {
    const copy = [
      localizedAiServiceUnavailable("nl-NL"),
      localizedDeterministicCopyNotice("nl-NL"),
      ...Object.values(localizedBriefingFallback("nl-NL")),
      ...Object.values(localizedAdvisorFallback("nl-NL")),
    ].join(" ");

    expect(copy).toContain("AI-samenvatting");
    expect(copy).toContain("AI-analyse");
    expect(copy).not.toContain("temporarily unavailable");
  });

  it("keeps deterministic Romanian fallback copy native", () => {
    const copy = [
      localizedAiServiceUnavailable("ro-RO"),
      localizedDeterministicCopyNotice("ro-RO"),
      ...Object.values(localizedBriefingFallback("ro-RO")),
      ...Object.values(localizedAdvisorFallback("ro-RO")),
    ].join(" ");

    expect(copy).toContain("Rezumatul AI");
    expect(copy).toContain("Analiza AI");
    expect(copy).not.toContain("temporarily unavailable");
  });

  it.each(localeCases)(
    "reports deterministic coverage locale behavior for %s",
    (_input, requestedLocale) => {
      const evaluationLocale = requestedLocale === "cs" ? "cs" : "en";
      const content =
        evaluationLocale === "cs"
          ? "Dvouhodinova rezervace studia stoji 450 Kc za osobu."
          : "A two-hour studio booking costs 450 CZK per person.";
      const result = evaluateKnowledgeCoverage({
        locale: requestedLocale,
        generatedAt: "2026-08-15T10:00:00.000Z",
        articles: [{ content }],
      });

      expect(result).toMatchObject({
        requestedLocale,
        evaluationLocale,
        localeFallback: requestedLocale !== evaluationLocale,
        answeredCount: 1,
      });
      expect(result.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "booking_price" }),
        ]),
      );
    },
  );

  it.each(["ja-JP", "nn-NO", "pt-BR", "en.$where", "../../secrets", "english"])(
    "rejects non-rollout locale %s",
    (locale) => {
      expect(aiLocaleSchema.safeParse(locale).success).toBe(false);
      expect(
        publicConciergeSchema.safeParse({ message: "Hello", locale }).success,
      ).toBe(false);
      expect(
        aiSettingsPatchSchema.safeParse({ defaultLocale: locale }).success,
      ).toBe(false);
    },
  );
});
