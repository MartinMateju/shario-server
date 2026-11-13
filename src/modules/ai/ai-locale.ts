import {
  APP_LOCALE,
  ROLLOUT_ELIGIBLE_APP_LOCALES,
  normalizeRolloutEligibleAppLocale,
  resolveRolloutEligibleAppLocale,
  type RolloutEligibleAppLocale,
} from "@/shared/i18n/locales.js";

export const AI_LOCALES = ROLLOUT_ELIGIBLE_APP_LOCALES;

export type AiLocale = RolloutEligibleAppLocale;

export const normalizeAiLocale = (value: unknown): AiLocale | null =>
  normalizeRolloutEligibleAppLocale(value);

export const resolveAiLocale = (
  value: unknown,
  fallback: AiLocale = APP_LOCALE.EN,
): AiLocale => resolveRolloutEligibleAppLocale(value, fallback);

export const isCoreAiLocale = (locale: unknown): boolean => {
  const normalized = normalizeAiLocale(locale);
  return normalized === APP_LOCALE.EN || normalized === APP_LOCALE.CS;
};

export const AI_LOCALE_LANGUAGE_NAME: Record<AiLocale, string> = {
  en: "English",
  cs: "Czech",
  de: "German",
  pl: "Polish",
  sk: "Slovak",
  da: "Danish",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  "pt-PT": "European Portuguese",
  sv: "Swedish",
  nb: "Norwegian Bokmål",
  fi: "Finnish",
  hu: "Hungarian",
  el: "Greek",
  tr: "Turkish",
  nl: "Dutch",
  ro: "Romanian",
};

export const aiResponseLanguageInstruction = (localeValue: unknown): string => {
  const locale = resolveAiLocale(localeValue);
  return [
    `Write every user-facing string in natural native ${AI_LOCALE_LANGUAGE_NAME[locale]} (${locale}).`,
    "This includes answers, summaries, labels, handoff reasons, suggested replies, and navigation labels.",
    "response_locale is authoritative for this turn even when earlier conversation messages use another language.",
  ].join(" ");
};

export const aiCopy = (
  localeValue: unknown,
  copy: Record<AiLocale, string>,
): string => copy[resolveAiLocale(localeValue)];

export const localizedAiServiceUnavailable = (locale: unknown): string =>
  aiCopy(locale, {
    en: "The live localized response is temporarily unavailable. Please try again in a moment.",
    cs: "Živá lokalizovaná odpověď je dočasně nedostupná. Zkuste to prosím za chvíli znovu.",
    de: "Die lokalisierte Live-Antwort ist vorübergehend nicht verfügbar. Bitte versuchen Sie es gleich noch einmal.",
    pl: "Zlokalizowana odpowiedź na żywo jest chwilowo niedostępna. Spróbuj ponownie za chwilę.",
    sk: "Lokalizovaná odpoveď naživo je dočasne nedostupná. Skúste to o chvíľu znova.",
    da: "Det lokaliserede live-svar er midlertidigt utilgængeligt. Prøv igen om et øjeblik.",
    fr: "La réponse localisée en direct est temporairement indisponible. Veuillez réessayer dans un instant.",
    es: "La respuesta localizada en directo no está disponible temporalmente. Inténtalo de nuevo en unos instantes.",
    it: "La risposta localizzata in tempo reale non è temporaneamente disponibile. Riprova tra poco.",
    "pt-PT":
      "A resposta localizada em direto está temporariamente indisponível. Tente novamente dentro de instantes.",
    sv: "Det lokaliserade svaret i realtid är tillfälligt otillgängligt. Försök igen om en liten stund.",
    nb: "Det lokaliserte svaret er midlertidig utilgjengelig. Prøv igjen om et øyeblikk.",
    fi: "Lokalisoitu reaaliaikainen vastaus ei ole tällä hetkellä saatavilla. Yritä hetken kuluttua uudelleen.",
    hu: "A valós idejű, lokalizált válasz átmenetileg nem érhető el. Kérjük, próbálja újra egy pillanat múlva.",
    el: "Η απάντηση σε πραγματικό χρόνο στη γλώσσα σας είναι προσωρινά μη διαθέσιμη. Δοκιμάστε ξανά σε λίγο.",
    tr: "Yerelleştirilmiş gerçek zamanlı yanıt geçici olarak kullanılamıyor. Lütfen birazdan tekrar deneyin.",
    nl: "Het actuele antwoord is tijdelijk niet beschikbaar in jouw taal. Probeer het over een moment opnieuw.",
    ro: "Răspunsul localizat în timp real este indisponibil temporar. Încearcă din nou peste câteva momente.",
  });

export const localizedBookingComposerNavigationLabel = (
  locale: unknown,
  variant: "unprefilled" | "prefilled",
): string => {
  const copy: Record<AiLocale, { unprefilled: string; prefilled: string }> = {
    en: {
      unprefilled: "Open unprefilled New booking form",
      prefilled: "Review prefilled booking",
    },
    cs: {
      unprefilled: "Otevřít prázdný formulář Nová rezervace",
      prefilled: "Zkontrolovat předvyplněnou rezervaci",
    },
    de: {
      unprefilled: "Leeres Formular „Neue Buchung“ öffnen",
      prefilled: "Vorausgefüllte Buchung prüfen",
    },
    pl: {
      unprefilled: "Otwórz pusty formularz nowej rezerwacji",
      prefilled: "Sprawdź wstępnie wypełnioną rezerwację",
    },
    sk: {
      unprefilled: "Otvoriť prázdny formulár novej rezervácie",
      prefilled: "Skontrolovať predvyplnenú rezerváciu",
    },
    da: {
      unprefilled: "Åbn tom formular til ny booking",
      prefilled: "Gennemgå forudfyldt booking",
    },
    fr: {
      unprefilled: "Ouvrir le formulaire Nouvelle réservation vide",
      prefilled: "Vérifier la réservation préremplie",
    },
    es: {
      unprefilled: "Abrir el formulario Nueva reserva vacío",
      prefilled: "Revisar la reserva precompletada",
    },
    it: {
      unprefilled: "Apri il modulo Nuova prenotazione vuoto",
      prefilled: "Controlla la prenotazione precompilata",
    },
    "pt-PT": {
      unprefilled: "Abrir o formulário Nova reserva em branco",
      prefilled: "Rever a reserva pré-preenchida",
    },
    sv: {
      unprefilled: "Öppna ett tomt formulär för ny bokning",
      prefilled: "Granska förifylld bokning",
    },
    nb: {
      unprefilled: "Åpne et tomt skjema for ny booking",
      prefilled: "Se gjennom forhåndsutfylt booking",
    },
    fi: {
      unprefilled: "Avaa tyhjä Uusi varaus -lomake",
      prefilled: "Tarkista esitäytetty varaus",
    },
    hu: {
      unprefilled: "Üres Új foglalás űrlap megnyitása",
      prefilled: "Előre kitöltött foglalás ellenőrzése",
    },
    el: {
      unprefilled: "Άνοιγμα κενής φόρμας Νέας κράτησης",
      prefilled: "Έλεγχος προσυμπληρωμένης κράτησης",
    },
    tr: {
      unprefilled: "Boş yeni rezervasyon formunu aç",
      prefilled: "Önceden doldurulmuş rezervasyonu gözden geçir",
    },
    nl: {
      unprefilled: "Een leeg formulier voor een nieuwe boeking openen",
      prefilled: "Vooraf ingevulde boeking controleren",
    },
    ro: {
      unprefilled: "Deschide formularul necompletat pentru o rezervare nouă",
      prefilled: "Verifică rezervarea completată în prealabil",
    },
  };
  return copy[resolveAiLocale(locale)][variant];
};

export const localizedSetupNavigationLabel = (locale: unknown): string =>
  aiCopy(locale, {
    en: "Open recommended setup",
    cs: "Otevřít doporučené nastavení",
    de: "Empfohlene Einrichtung öffnen",
    pl: "Otwórz zalecaną konfigurację",
    sk: "Otvoriť odporúčané nastavenie",
    da: "Åbn anbefalet opsætning",
    fr: "Ouvrir la configuration recommandée",
    es: "Abrir la configuración recomendada",
    it: "Apri la configurazione consigliata",
    "pt-PT": "Abrir a configuração recomendada",
    sv: "Öppna rekommenderad konfiguration",
    nb: "Åpne anbefalt oppsett",
    fi: "Avaa suositellut asetukset",
    hu: "Javasolt beállítás megnyitása",
    el: "Άνοιγμα προτεινόμενης ρύθμισης",
    tr: "Önerilen kurulumu aç",
    nl: "Aanbevolen configuratie openen",
    ro: "Deschide configurarea recomandată",
  });
