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

export const localizedDeterministicCopyNotice = (locale: unknown): string =>
  aiCopy(locale, {
    en: "The verified details below are shown in English because the live localized response is unavailable.",
    cs: "Níže uvedené ověřené údaje jsou zobrazeny v angličtině, protože živá lokalizovaná odpověď není dostupná.",
    de: "Die verifizierten Angaben unten werden auf Englisch angezeigt, weil die lokalisierte Live-Antwort nicht verfügbar ist.",
    pl: "Poniższe zweryfikowane informacje są wyświetlane po angielsku, ponieważ zlokalizowana odpowiedź na żywo jest niedostępna.",
    sk: "Overené údaje nižšie sú zobrazené v angličtine, pretože lokalizovaná odpoveď naživo nie je dostupná.",
    da: "De verificerede oplysninger nedenfor vises på engelsk, fordi det lokaliserede live-svar ikke er tilgængeligt.",
    fr: "Les informations vérifiées ci-dessous sont affichées en anglais, car la réponse localisée en direct n’est pas disponible.",
    es: "La información verificada que aparece a continuación se muestra en inglés porque la respuesta localizada en directo no está disponible.",
    it: "Le informazioni verificate qui sotto sono mostrate in inglese perché la risposta localizzata in tempo reale non è disponibile.",
    "pt-PT":
      "As informações verificadas abaixo são apresentadas em inglês porque a resposta localizada em direto não está disponível.",
    sv: "De verifierade uppgifterna nedan visas på engelska eftersom det lokaliserade svaret i realtid inte är tillgängligt.",
    nb: "De verifiserte opplysningene nedenfor vises på engelsk fordi det lokaliserte svaret ikke er tilgjengelig.",
    fi: "Alla olevat vahvistetut tiedot näytetään englanniksi, koska lokalisoitu reaaliaikainen vastaus ei ole tällä hetkellä saatavilla.",
    hu: "Az alábbi ellenőrzött adatok angolul jelennek meg, mert a valós idejű, lokalizált válasz nem érhető el.",
    el: "Οι παρακάτω επαληθευμένες πληροφορίες εμφανίζονται στα αγγλικά, επειδή η απάντηση σε πραγματικό χρόνο στη γλώσσα σας δεν είναι διαθέσιμη.",
    tr: "Yerelleştirilmiş gerçek zamanlı yanıt kullanılamadığı için aşağıdaki doğrulanmış ayrıntılar İngilizce gösterilmektedir.",
    nl: "De geverifieerde gegevens hieronder worden in het Engels weergegeven, omdat er momenteel geen antwoord in jouw taal beschikbaar is.",
    ro: "Detaliile verificate de mai jos sunt afișate în limba engleză deoarece răspunsul localizat în timp real nu este disponibil.",
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

export const localizedBriefingFallback = (
  locale: unknown,
): { headline: string; summary: string } => ({
  headline: aiCopy(locale, {
    en: "Your verified studio briefing",
    cs: "Váš ověřený přehled studia",
    de: "Ihr verifizierter Studioüberblick",
    pl: "Zweryfikowany przegląd studia",
    sk: "Váš overený prehľad štúdia",
    da: "Dit verificerede studieoverblik",
    fr: "Votre synthèse vérifiée du studio",
    es: "Tu resumen verificado del estudio",
    it: "Il riepilogo verificato del tuo studio",
    "pt-PT": "O resumo verificado do seu estúdio",
    sv: "Din verifierade studioöversikt",
    nb: "Din verifiserte studiooversikt",
    fi: "Studiosi vahvistettu tilannekatsaus",
    hu: "Stúdiója ellenőrzött összefoglalója",
    el: "Η επαληθευμένη ενημέρωση του στούντιό σας",
    tr: "Doğrulanmış stüdyo özetiniz",
    nl: "Jouw geverifieerde studio-overzicht",
    ro: "Rezumatul verificat al studioului tău",
  }),
  summary: aiCopy(locale, {
    en: "The live AI summary is temporarily unavailable. Review the verified operational items below.",
    cs: "Živé AI shrnutí je dočasně nedostupné. Projděte si níže uvedené ověřené provozní položky.",
    de: "Die Live-KI-Zusammenfassung ist vorübergehend nicht verfügbar. Prüfen Sie die verifizierten Betriebshinweise unten; einzelne Bezeichnungen können auf Englisch erscheinen.",
    pl: "Podsumowanie AI na żywo jest chwilowo niedostępne. Sprawdź zweryfikowane informacje operacyjne poniżej; niektóre etykiety mogą być po angielsku.",
    sk: "Živé AI zhrnutie je dočasne nedostupné. Skontrolujte overené prevádzkové položky nižšie; niektoré označenia môžu byť v angličtine.",
    da: "AI-oversigten i realtid er midlertidigt utilgængelig. Gennemgå de verificerede driftspunkter nedenfor; enkelte betegnelser kan stå på engelsk.",
    fr: "La synthèse IA en direct est temporairement indisponible. Consultez les éléments opérationnels vérifiés ci-dessous ; certains libellés peuvent apparaître en anglais.",
    es: "El resumen de IA en directo no está disponible temporalmente. Revisa los elementos operativos verificados que aparecen a continuación; algunas etiquetas pueden mostrarse en inglés.",
    it: "Il riepilogo IA in tempo reale non è temporaneamente disponibile. Controlla gli elementi operativi verificati qui sotto; alcune etichette potrebbero essere in inglese.",
    "pt-PT":
      "O resumo de IA em direto está temporariamente indisponível. Consulte os elementos operacionais verificados abaixo; algumas etiquetas podem aparecer em inglês.",
    sv: "AI-sammanfattningen i realtid är tillfälligt otillgänglig. Granska de verifierade driftuppgifterna nedan; vissa etiketter kan visas på engelska.",
    nb: "KI-sammendraget i sanntid er midlertidig utilgjengelig. Se gjennom de verifiserte driftsopplysningene nedenfor; enkelte etiketter kan vises på engelsk.",
    fi: "Reaaliaikainen tekoäly-yhteenveto ei ole tällä hetkellä saatavilla. Tarkista alla olevat vahvistetut toiminnan tiedot; osa nimikkeistä voi näkyä englanniksi.",
    hu: "A valós idejű MI-összefoglaló átmenetileg nem érhető el. Tekintse át az alábbi ellenőrzött működési adatokat; egyes címkék angolul jelenhetnek meg.",
    el: "Η σύνοψη ΤΝ σε πραγματικό χρόνο είναι προσωρινά μη διαθέσιμη. Ελέγξτε τα επαληθευμένα λειτουργικά στοιχεία παρακάτω· ορισμένες ετικέτες ενδέχεται να εμφανίζονται στα αγγλικά.",
    tr: "Gerçek zamanlı yapay zekâ özeti geçici olarak kullanılamıyor. Aşağıdaki doğrulanmış operasyon bilgilerini inceleyin; bazı etiketler İngilizce görünebilir.",
    nl: "De live AI-samenvatting is tijdelijk niet beschikbaar. Bekijk hieronder de geverifieerde operationele gegevens; sommige labels kunnen in het Engels worden weergegeven.",
    ro: "Rezumatul AI în timp real este indisponibil temporar. Consultă mai jos informațiile operaționale verificate; unele etichete pot fi afișate în limba engleză.",
  }),
});

export const localizedAdvisorFallback = (
  locale: unknown,
): { headline: string; summary: string } => ({
  headline: aiCopy(locale, {
    en: "Verified studio recommendations",
    cs: "Ověřená doporučení pro studio",
    de: "Verifizierte Studioempfehlungen",
    pl: "Zweryfikowane rekomendacje dla studia",
    sk: "Overené odporúčania pre štúdio",
    da: "Verificerede anbefalinger til studiet",
    fr: "Recommandations vérifiées pour le studio",
    es: "Recomendaciones verificadas para el estudio",
    it: "Consigli verificati per lo studio",
    "pt-PT": "Recomendações verificadas para o estúdio",
    sv: "Verifierade rekommendationer för studion",
    nb: "Verifiserte anbefalinger for studioet",
    fi: "Studion vahvistetut suositukset",
    hu: "Ellenőrzött stúdiójavaslatok",
    el: "Επαληθευμένες προτάσεις για το στούντιο",
    tr: "Doğrulanmış stüdyo önerileri",
    nl: "Geverifieerde aanbevelingen voor de studio",
    ro: "Recomandări verificate pentru studio",
  }),
  summary: aiCopy(locale, {
    en: "The live AI narrative is temporarily unavailable. The recommendation cards below remain grounded in verified studio data.",
    cs: "Živý AI komentář je dočasně nedostupný. Níže uvedené karty doporučení nadále vycházejí z ověřených dat studia.",
    de: "Die Live-KI-Einordnung ist vorübergehend nicht verfügbar. Die Empfehlungskarten unten basieren weiterhin auf verifizierten Studiodaten und können auf Englisch erscheinen.",
    pl: "Opis AI na żywo jest chwilowo niedostępny. Karty rekomendacji poniżej nadal opierają się na zweryfikowanych danych studia i mogą być wyświetlane po angielsku.",
    sk: "Živý AI komentár je dočasne nedostupný. Karty odporúčaní nižšie naďalej vychádzajú z overených údajov štúdia a môžu byť zobrazené v angličtine.",
    da: "AI-vurderingen i realtid er midlertidigt utilgængelig. Anbefalingskortene nedenfor bygger fortsat på verificerede studiedata og kan blive vist på engelsk.",
    fr: "L’analyse IA en direct est temporairement indisponible. Les cartes de recommandation ci-dessous restent fondées sur des données vérifiées du studio et peuvent apparaître en anglais.",
    es: "El análisis de IA en directo no está disponible temporalmente. Las tarjetas de recomendaciones siguen basándose en datos verificados del estudio y pueden mostrarse en inglés.",
    it: "L’analisi IA in tempo reale non è temporaneamente disponibile. Le schede dei consigli continuano a basarsi su dati verificati dello studio e potrebbero essere mostrate in inglese.",
    "pt-PT":
      "A análise de IA em direto está temporariamente indisponível. Os cartões de recomendação abaixo continuam baseados em dados verificados do estúdio e podem aparecer em inglês.",
    sv: "AI-analysen i realtid är tillfälligt otillgänglig. Rekommendationskorten nedan bygger fortfarande på verifierade studiodata och kan visas på engelska.",
    nb: "KI-analysen i sanntid er midlertidig utilgjengelig. Anbefalingskortene nedenfor bygger fortsatt på verifiserte studiodata og kan vises på engelsk.",
    fi: "Reaaliaikainen tekoälyanalyysi ei ole tällä hetkellä saatavilla. Alla olevat suosituskortit perustuvat edelleen studion vahvistettuihin tietoihin ja voivat näkyä englanniksi.",
    hu: "A valós idejű MI-elemzés átmenetileg nem érhető el. Az alábbi javaslatkártyák továbbra is a stúdió ellenőrzött adatain alapulnak, és angolul jelenhetnek meg.",
    el: "Η ανάλυση ΤΝ σε πραγματικό χρόνο είναι προσωρινά μη διαθέσιμη. Οι παρακάτω κάρτες προτάσεων εξακολουθούν να βασίζονται σε επαληθευμένα δεδομένα του στούντιο και ενδέχεται να εμφανίζονται στα αγγλικά.",
    tr: "Gerçek zamanlı yapay zekâ değerlendirmesi geçici olarak kullanılamıyor. Aşağıdaki öneri kartları doğrulanmış stüdyo verilerine dayanır ve İngilizce görünebilir.",
    nl: "De live AI-analyse is tijdelijk niet beschikbaar. De aanbevelingskaarten hieronder blijven gebaseerd op geverifieerde studiogegevens en kunnen in het Engels worden weergegeven.",
    ro: "Analiza AI în timp real este indisponibilă temporar. Cardurile cu recomandări de mai jos se bazează în continuare pe date verificate despre studio și pot fi afișate în limba engleză.",
  }),
});
