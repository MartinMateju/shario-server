import { buildUTCBookingRangeFromLocalInputs } from "@/shared/time/time.utils.js";

import { localizedBookingComposerNavigationLabel } from "../ai-locale.js";
import type { AiCommandContext } from "../ai-action.types.js";
import type { AssistantProviderOutput } from "../ai.validators.js";

export type BookingComposerNavigation = {
  kind: "booking_composer";
  label: string;
  href: string;
};

export type DeterministicBookingHandoff = {
  response: AssistantProviderOutput;
  navigation: BookingComposerNavigation[];
};

const normalizedText = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const localizedCzech = (locale: string): boolean =>
  locale.toLowerCase().startsWith("cs") ||
  locale.toLowerCase().startsWith("cz");

const workspaceAnswer = (
  answer: string,
  suggestedReplies: string[] = [],
): AssistantProviderOutput => ({
  answer,
  grounding: {
    basis: "workspace_facts",
    insufficientEvidence: false,
  },
  citations: [],
  actions: [],
  suggestedReplies: suggestedReplies.slice(0, 4),
  navigation: [],
});

export const isExplicitCreateBookingRequest = (message: string): boolean => {
  const request = message.trim();
  return (
    /^(?:(?:please\s+)?(?:create|add|make)|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:create|add|make))\s+(?:a|the)?\s*(?:(?:private|internal|studio|customer|new)\s+){0,4}(?:booking|reservation)\b/iu.test(
      request,
    ) ||
    /^(?:(?:please\s+)?(?:book|reserve)|(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:book|reserve))\s+(?:me|us)?\b/iu.test(
      request,
    ) ||
    /^(?:(?:prosím\s+)?(?:vytvoř|vytvor|založ|zaloz|přidej|pridej))\s+(?:mi\s+)?(?:rezervaci|rezervace)\b/iu.test(
      request,
    )
  );
};

const bookingComposerHref = (
  prefill?: {
    productId: string;
    locationId: string;
    start: string;
    end: string;
  } | null,
): string => {
  const params = new URLSearchParams();
  if (prefill) {
    params.set("productId", prefill.productId);
    params.set("locationId", prefill.locationId);
    params.set("start", prefill.start);
    params.set("end", prefill.end);
  }
  params.set("returnTo", "/app/ai");
  return "/app/bookings/new?" + params.toString();
};

const quotedValue = (message: string): string =>
  message.match(/[“"]([^”"]{1,160})[”"]/u)?.[1]?.trim() || "";

const exactNamedMatches = <T extends { name: string }>(
  message: string,
  values: T[],
): T[] => {
  const normalized = normalizedText(message);
  return values.filter((value) => {
    const name = normalizedText(value.name);
    return Boolean(name) && (" " + normalized + " ").includes(" " + name + " ");
  });
};

const explicitPositiveLocationMatch = <T extends { name: string }>({
  message,
  values,
}: {
  message: string;
  values: T[];
}): T | null => {
  const outsideQuotedText = normalizedText(
    message.replace(/["“„][^"“”„]{1,160}["”]/gu, " "),
  );
  if (
    /\b(?:not|except|excluding|instead|nikoli|mimo|ne)\b/u.test(
      outsideQuotedText,
    )
  ) {
    return null;
  }

  const locationClauses: string[] = [];
  const prefix = /\b(?:at|in|v|ve|na)\s+(?:the\s+)?/gu;
  for (const match of outsideQuotedText.matchAll(prefix)) {
    const remainder = outsideQuotedText.slice(
      (match.index ?? 0) + match[0].length,
    );
    if (
      /^(?:\d|today\b|tomorrow\b|morning\b|afternoon\b|evening\b|noon\b|midnight\b|dnes\b|zitra\b|rano\b|dopoledne\b|odpoledne\b|vecer\b)/u.test(
        remainder,
      )
    ) {
      continue;
    }
    locationClauses.push(remainder);
  }
  if (locationClauses.length !== 1) return null;

  const clause = locationClauses[0]!;
  const matches = values.filter((value) => {
    const name = normalizedText(value.name);
    if (!name || !clause.startsWith(name)) return false;
    const tail = clause.slice(name.length).trim();
    return (
      !tail ||
      /^(?:today\b|tomorrow\b|on\b|at\b|from\b|for\b|dnes\b|zitra\b|v\b|ve\b|od\b|na\b|po\b|\d{4}\b)/u.test(
        tail,
      )
    );
  });
  return matches.length === 1 ? matches[0]! : null;
};

const dateInTimezone = (date: Date, timezone: string): string | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const value = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return value.year && value.month && value.day
      ? value.year + "-" + value.month + "-" + value.day
      : null;
  } catch {
    return null;
  }
};

const addCalendarDays = (date: string, days: number): string | null => {
  const parsed = new Date(date + "T12:00:00.000Z");
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};

const wallDateTime = (
  date: Date,
  timezone: string,
): { date: string; time: string } | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return value.year &&
      value.month &&
      value.day &&
      value.hour &&
      value.minute
      ? {
          date: value.year + "-" + value.month + "-" + value.day,
          time: value.hour + ":" + value.minute,
        }
      : null;
  } catch {
    return null;
  }
};

const parseClock = (raw: string): { formatted: string; minutes: number } | null => {
  const match = raw
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const marker = (match[3] || "").replaceAll(".", "");
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    if (marker === "am") hour = hour === 12 ? 0 : hour;
    if (marker === "pm") hour = hour === 12 ? 12 : hour + 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return {
    formatted:
      String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"),
    minutes: hour * 60 + minute,
  };
};

const CLOCK =
  "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?";
const EXPLICIT_CLOCK =
  "\\d{1,2}(?::\\d{2}\\s*|\\s*(?:a\\.?m\\.?|p\\.?m\\.?))";

const requestedTimes = (
  message: string,
): {
  start: { formatted: string; minutes: number };
  end: { formatted: string; minutes: number };
  durationMinutes: number;
} | null => {
  const normalized = message
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const introducedRange = normalized.match(
    new RegExp(
      "\\b(?:from|od)\\s+(" +
        CLOCK +
        ")\\s+(?:to|until|do)\\s+(" +
        CLOCK +
        ")\\b",
      "i",
    ),
  );
  const explicitRange =
    introducedRange ||
    normalized.match(
      new RegExp(
        "\\b(" +
          EXPLICIT_CLOCK +
          ")\\s*(?:-|–|to|until|do)\\s*(" +
          CLOCK +
          ")\\b",
        "i",
      ),
    );
  const durationMatch = normalized.match(
    /\b(?:for|na|po dobu)\s+(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|hodinu|hodiny|hodin|minutes?|mins?|minut(?:u|y)?)\b/i,
  );
  const durationFromText = durationMatch
    ? Math.round(
        Number(durationMatch[1]!.replace(",", ".")) *
          (/^(hours?|hrs?|hodinu|hodiny|hodin)$/i.test(durationMatch[2]!)
            ? 60
            : 1),
      )
    : null;

  if (explicitRange) {
    const start = parseClock(explicitRange[1]!);
    const end = parseClock(explicitRange[2]!);
    if (!start || !end || end.minutes <= start.minutes) return null;
    const durationMinutes = end.minutes - start.minutes;
    if (
      durationFromText !== null &&
      durationFromText !== durationMinutes
    ) {
      return null;
    }
    return { start, end, durationMinutes };
  }

  const startMatch = normalized.match(
    new RegExp("\\b(?:at|from|v|od)\\s+(" + CLOCK + ")\\b", "i"),
  );
  const start = startMatch ? parseClock(startMatch[1]!) : null;
  if (!start || durationFromText === null || durationFromText <= 0) return null;
  const endMinutes = start.minutes + durationFromText;
  if (endMinutes >= 24 * 60) return null;
  const end = {
    minutes: endMinutes,
    formatted:
      String(Math.floor(endMinutes / 60)).padStart(2, "0") +
      ":" +
      String(endMinutes % 60).padStart(2, "0"),
  };
  return { start, end, durationMinutes: durationFromText };
};

const explicitDate = (
  message: string,
  timezone: string,
  now: Date,
): string | null => {
  const iso = message.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;
  const normalized = normalizedText(message);
  const today = dateInTimezone(now, timezone);
  if (!today) return null;
  if (/\b(tomorrow|zitra|zitrejsi)\b/.test(normalized)) {
    return addCalendarDays(today, 1);
  }
  if (/\b(today|dnes|dnesni)\b/.test(normalized)) {
    return today;
  }
  return null;
};

const offsetMinutesAt = (date: Date, timezone: string): number | null => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    if (
      !value.year ||
      !value.month ||
      !value.day ||
      !value.hour ||
      !value.minute ||
      !value.second
    ) {
      return null;
    }
    const representedUtc = Date.UTC(
      Number(value.year),
      Number(value.month) - 1,
      Number(value.day),
      Number(value.hour),
      Number(value.minute),
      Number(value.second),
    );
    return Math.round((representedUtc - date.getTime()) / 60_000);
  } catch {
    return null;
  }
};

const localRangeCrossesOffsetTransition = ({
  start,
  end,
  timezone,
}: {
  start: Date;
  end: Date;
  timezone: string;
}): boolean => {
  const startOffset = offsetMinutesAt(start, timezone);
  const beforeOffset = offsetMinutesAt(
    new Date(start.getTime() - 3 * 60 * 60_000),
    timezone,
  );
  const endOffset = offsetMinutesAt(end, timezone);
  const afterOffset = offsetMinutesAt(
    new Date(end.getTime() + 3 * 60 * 60_000),
    timezone,
  );
  return (
    startOffset === null ||
    beforeOffset === null ||
    endOffset === null ||
    afterOffset === null ||
    startOffset !== beforeOffset ||
    startOffset !== endOffset ||
    endOffset !== afterOffset
  );
};

const dayKey = (date: string): string | null => {
  const parsed = new Date(date + "T12:00:00.000Z");
  if (Number.isNaN(parsed.getTime())) return null;
  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][parsed.getUTCDay()]!;
};

const clockMinutes = (value: string, allow24 = false): number | null => {
  if (allow24 && value === "24:00") return 24 * 60;
  const parsed = parseClock(value);
  return parsed?.minutes ?? null;
};

const genericBookingFormRequest = (message: string): boolean => {
  const normalized = normalizedText(message);
  return (
    /^(please )?(create|add|make) (a |the )?(new )?(booking|reservation)$/.test(
      normalized,
    ) ||
    /^(book|reserve)( me| us)?$/.test(normalized) ||
    /^(prosim )?(vytvor|zaloz|pridej)( mi)? (novou )?(rezervaci|rezervace)$/.test(
      normalized,
    )
  );
};

export const resolveDeterministicBookingHandoff = ({
  message,
  locale,
  commandContext,
  now = new Date(),
}: {
  message: string;
  locale: string;
  commandContext: AiCommandContext;
  now?: Date;
}): DeterministicBookingHandoff | null => {
  if (!isExplicitCreateBookingRequest(message)) return null;
  const czech = localizedCzech(locale);
  const composer = commandContext.assistantCapabilities?.bookingComposer;
  if (composer?.enabled !== true) {
    return {
      response: workspaceAnswer(
        czech
          ? "Rezervaci jsem nevytvořil a pro tento účet teď nemohu otevřít formulář Nová rezervace. Zkontrolujte, zda je modul Rezervace zapnutý a zda máte oprávnění vytvářet rezervace."
          : "I haven’t created a booking, and I can’t open the New booking form for this account right now. Check that the Bookings module is enabled and that you have permission to create bookings.",
      ),
      navigation: [],
    };
  }

  if (genericBookingFormRequest(message)) {
    return {
      response: workspaceAnswer(
        czech
          ? "Rezervaci jsem nevytvořil ani nepředvyplnil. Otevřete formulář Nová rezervace, zkontrolujte všechny údaje a odešlete ho až tehdy, když je vše správně."
          : "I haven’t created or prefilled a booking. Open the New booking form, review every field, and submit it only when everything is correct.",
      ),
      navigation: [
        {
          kind: "booking_composer",
          label: localizedBookingComposerNavigationLabel(
            locale,
            "unprefilled",
          ),
          href: bookingComposerHref(),
        },
      ],
    };
  }

  if (composer.prefillEnabled !== true) {
    return {
      response: workspaceAnswer(
        czech
          ? "Rezervaci jsem nevytvořil. Podrobnosti nemohu bezpečně předvyplnit, protože pro tento účet nemohu ověřit aktivní rezervační produkty. Otevřete Rezervace a zvolte Nová rezervace ručně."
          : "I haven’t created a booking. I can’t safely prefill the details because active booking products aren’t available to this account. Open Bookings and choose New booking manually.",
      ),
      navigation: [],
    };
  }

  const products = commandContext.bookingProducts || [];
  const quote = quotedValue(message);
  let productMatches = quote
    ? products.filter(
        (product) => normalizedText(product.name) === normalizedText(quote),
      )
    : exactNamedMatches(message, products);
  const normalized = normalizedText(message);
  const exactPrivateStudioKind =
    /\b(private studio|internal studio block|private studio block|interni blok studia)\b/.test(
      normalized,
    );
  const ambiguousPrivateBooking =
    /\b(private booking|private reservation|soukroma rezervace|soukromou rezervaci)\b/.test(
      normalized,
    ) && !exactPrivateStudioKind;
  if (!quote && productMatches.length === 0 && exactPrivateStudioKind) {
    productMatches = products.filter(
      (product) => product.kind === "private-studio",
    );
  }
  if (quote && productMatches.length !== 1) {
    return {
      response: workspaceAnswer(
        czech
          ? "Text „" +
              quote +
              "“ přesně neodpovídá jednomu aktivnímu rezervačnímu produktu. Název ani poznámku formulářem nepřenáším, takže vyberte přesný produkt a požadavek pošlete znovu. Nic jsem nevytvořil."
          : "“" +
              quote +
              "” does not match exactly one active booking product. The form handoff cannot carry a custom title or note, so name the exact product and send the request again. I haven’t created anything.",
      ),
      navigation: [],
    };
  }
  if (ambiguousPrivateBooking && productMatches.length !== 1) {
    return {
      response: workspaceAnswer(
        czech
          ? "„Soukromá rezervace“ může znamenat rezervaci zákazníka nebo interní blok studia. Uveďte přesný aktivní produkt, případně výslovně napište „interní blok studia“. Název ani poznámku nepředvyplňuji a nic jsem nevytvořil."
          : "“Private booking” can mean a customer reservation or an internal studio block. Name the exact active product, or explicitly say “internal studio block.” I can’t prefill a custom title or note, and I haven’t created anything.",
      ),
      navigation: [],
    };
  }
  if (productMatches.length !== 1) {
    return {
      response: workspaceAnswer(
        czech
          ? productMatches.length > 1
            ? "Požadavek odpovídá více aktivním produktům. Uveďte jeden přesný název produktu; nic jsem nevytvořil."
            : "K bezpečnému předvyplnění potřebuji přesný název aktivního rezervačního produktu. Název ani poznámku rezervace z volného textu nepřenáším a nic jsem nevytvořil."
          : productMatches.length > 1
            ? "The request matches more than one active product. Name one exact product; I haven’t created anything."
            : "To prefill safely, I need the exact name of an active booking product. I can’t carry a free-text booking title or note into the form, and I haven’t created anything.",
      ),
      navigation: [],
    };
  }
  const product = productMatches[0]!;

  const bookingLocations = (commandContext.locations || []).filter(
    (location) => location.booking?.enabled === true,
  );
  const location = explicitPositiveLocationMatch({
    message,
    values: bookingLocations,
  });
  if (!location) {
    return {
      response: workspaceAnswer(
        czech
          ? "K bezpečnému předvyplnění uveďte právě jednu dostupnou provozovnu jejím přesným názvem po „v“, „ve“ nebo „na“. Chybějící, neznámou, skrytou, zápornou ani rozpornou provozovnu neodhadnu. Nic jsem nevytvořil."
          : "To prefill safely, name exactly one accessible booking-enabled location after “at” or “in.” I won’t guess an omitted, unknown, hidden, negated, or conflicting location. I haven’t created anything.",
      ),
      navigation: [],
    };
  }
  const timezone = location.booking.timezone;
  const date = explicitDate(message, timezone, now);
  if (!date) {
    return {
      response: workspaceAnswer(
        czech
          ? "Uveďte datum jako dnes, zítra nebo ve formátu RRRR-MM-DD. Rezervaci jsem nevytvořil."
          : "Specify the date as today, tomorrow, or YYYY-MM-DD. I haven’t created a booking.",
      ),
      navigation: [],
    };
  }
  const times = requestedTimes(message);
  if (!times) {
    return {
      response: workspaceAnswer(
        czech
          ? "Uveďte jednoznačný časový rozsah, například 09:00–10:00, nebo začátek a délku. Rozporuplný či neúplný čas nepředvyplňuji a nic jsem nevytvořil."
          : "Specify one unambiguous time range, such as 09:00–10:00, or a start time and duration. I won’t prefill an incomplete or conflicting time, and I haven’t created anything.",
      ),
      navigation: [],
    };
  }

  const slotStep = Number(location.booking.slotStepMinutes);
  const minMinutes = Number(location.booking.minBookingMinutes);
  const maxMinutes = Number(location.booking.maxBookingMinutes);
  if (
    !Number.isInteger(slotStep) ||
    slotStep <= 0 ||
    times.start.minutes % slotStep !== 0 ||
    times.durationMinutes % slotStep !== 0
  ) {
    return {
      response: workspaceAnswer(
        czech
          ? "Požadovaný začátek a délka neodpovídají kroku rezervací " +
              slotStep +
              " minut v provozovně " +
              location.name +
              ". Nic jsem nepředvyplnil ani nevytvořil."
          : "The requested start and duration do not align with the " +
              slotStep +
              "-minute booking step at " +
              location.name +
              ". I haven’t prefilled or created anything.",
      ),
      navigation: [],
    };
  }
  if (
    !Number.isFinite(minMinutes) ||
    !Number.isFinite(maxMinutes) ||
    times.durationMinutes < minMinutes ||
    times.durationMinutes > maxMinutes
  ) {
    return {
      response: workspaceAnswer(
        czech
          ? "Požadovaná délka musí být v provozovně " +
              location.name +
              " mezi " +
              minMinutes +
              " a " +
              maxMinutes +
              " minutami. Nic jsem nepředvyplnil ani nevytvořil."
          : "The requested duration at " +
              location.name +
              " must be between " +
              minMinutes +
              " and " +
              maxMinutes +
              " minutes. I haven’t prefilled or created anything.",
      ),
      navigation: [],
    };
  }

  const key = dayKey(date);
  const hours = key ? location.openingHours?.[key] : null;
  const open = clockMinutes(String(hours?.openTime || ""));
  const close = clockMinutes(String(hours?.closeTime || ""), true);
  if (
    !hours ||
    hours.isOpen !== true ||
    open === null ||
    close === null ||
    times.start.minutes < open ||
    times.end.minutes > close
  ) {
    return {
      response: workspaceAnswer(
        czech
          ? "Požadovaný čas není uvnitř otevírací doby provozovny " +
              location.name +
              " pro tento den. Nic jsem nepředvyplnil ani nevytvořil."
          : "The requested time is outside " +
              location.name +
              "’s opening hours for that day. I haven’t prefilled or created anything.",
      ),
      navigation: [],
    };
  }

  const range = buildUTCBookingRangeFromLocalInputs({
    date,
    startTime: times.start.formatted,
    endTime: times.end.formatted,
    timezone,
  });
  const startWall = range ? wallDateTime(range.start, timezone) : null;
  const endWall = range ? wallDateTime(range.end, timezone) : null;
  if (
    !range ||
    !startWall ||
    !endWall ||
    startWall.date !== date ||
    startWall.time !== times.start.formatted ||
    endWall.date !== date ||
    endWall.time !== times.end.formatted ||
    range.end.getTime() - range.start.getTime() !==
      times.durationMinutes * 60_000 ||
    localRangeCrossesOffsetTransition({
      start: range.start,
      end: range.end,
      timezone,
    })
  ) {
    return {
      response: workspaceAnswer(
        czech
          ? "Požadovaný místní čas nelze v časovém pásmu provozovny jednoznačně převést, například kvůli změně letního času. Nic jsem nepředvyplnil ani nevytvořil."
          : "The requested local time cannot be converted unambiguously in the location timezone, for example around a daylight-saving change. I haven’t prefilled or created anything.",
      ),
      navigation: [],
    };
  }
  if (range.start.getTime() <= now.getTime()) {
    return {
      response: workspaceAnswer(
        czech
          ? "Začátek rezervace musí být v budoucnosti podle časového pásma provozovny. Nic jsem nepředvyplnil ani nevytvořil."
          : "The booking start must be in the future in the location timezone. I haven’t prefilled or created anything.",
      ),
      navigation: [],
    };
  }

  const href = bookingComposerHref({
    productId: product.id,
    locationId: location.id,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  });
  return {
    response: workspaceAnswer(
      czech
        ? "Připravil jsem formulář Nová rezervace pro produkt " +
            product.name +
            " v provozovně " +
            location.name +
            " na " +
            date +
            " " +
            times.start.formatted +
            "–" +
            times.end.formatted +
            " (" +
            timezone +
            "). Rezervaci jsem nevytvořil; před odesláním zkontrolujte všechny údaje."
        : "I prepared the New booking form for " +
            product.name +
            " at " +
            location.name +
            " on " +
            date +
            " from " +
            times.start.formatted +
            " to " +
            times.end.formatted +
            " (" +
            timezone +
            "). I haven’t created a booking; review every field before submitting.",
    ),
    navigation: [
      {
        kind: "booking_composer",
        label: localizedBookingComposerNavigationLabel(locale, "prefilled"),
        href,
      },
    ],
  };
};
