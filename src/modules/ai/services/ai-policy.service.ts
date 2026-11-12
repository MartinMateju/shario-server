import { createHash } from "node:crypto";

import { badRequest } from "@/shared/http/httpErrors.js";

import { moderateText } from "./openai.provider.js";

const promptInjectionPatterns = [
  /ignore (all|any|the) previous instructions/i,
  /reveal (the )?(system|developer) prompt/i,
  /show (me )?(your )?(secrets?|api keys?|credentials?)/i,
  /act as (an? )?(administrator|owner|system)/i,
  /ignoruj(?:te)? (?:všechny|veškeré|předchozí|předešlé) (?:pokyny|instrukce)/i,
  /(?:odhal|ukaž|zobraz)(?:te)? (?:systémový|systemovy) (?:prompt|pokyn)/i,
  /(?:ukaž|zobraz)(?:te)? (?:tajemství|api klíč|api klic|přihlašovací údaje)/i,
  /chovej(?:te)? se jako (?:administrátor|administrator|vlastník|vlastnik|systém|system)/i,
];

const sensitiveAccessSecretPatterns = [
  /\b(?:door|entry|access|gate|alarm|lock|wifi|wi-fi)\s*(?:code|pin|password|key)?\s*(?:is|:|=|-)\s*(?:[a-z0-9 -]*\d[a-z0-9 -]{2,})\b/i,
  /\b(?:k[oó]d|pin|heslo|kl[ií]č)\s*(?:ke|k|pro)?\s*(?:dveř[ií]m|vstupu|br[aá]n[eě]|alarmu|wifi)?\s*(?:je|:|=|-)\s*(?:[a-z0-9 -]*\d[a-z0-9 -]{2,})\b/i,
  /\b(?:password|heslo)\b.{0,20}(?:[:=]|\bis\b|\bje\b)\s*["']?\S{4,}/i,
];

export const normalizeAiText = (value: unknown, maxLength: number): string =>
  String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);

export const hashPublicSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const moderateAiInput = async ({
  text,
  enabled = true,
}: {
  text: string;
  enabled?: boolean;
}) => {
  if (!enabled) return { flagged: false, categories: [] as string[] };
  const result = await moderateText(text);
  if (result.flagged) {
    badRequest({
      message: "This message cannot be processed by the assistant.",
      code: "AI_INPUT_BLOCKED",
      details: { categories: result.categories },
    });
  }
  return result;
};

export const containsPromptInjection = (text: string): boolean =>
  promptInjectionPatterns.some((pattern) => pattern.test(text));

export const containsSensitiveAccessSecret = (text: string): boolean =>
  sensitiveAccessSecretPatterns.some((pattern) => pattern.test(text));

const escapeUntrustedJson = (value: string): string =>
  value
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

const buildUntrustedEnvelope = (
  label: string,
  serializedValue: string,
): string =>
  [
    `<untrusted_${label}>`,
    escapeUntrustedJson(serializedValue),
    `</untrusted_${label}>`,
  ].join("\n");

export const untrustedContextEnvelope = (
  label: string,
  value: unknown,
): string => {
  // Keep the payload valid JSON while preventing stored/user-controlled text
  // from emitting literal XML-like delimiters that could appear to close this
  // untrusted-data boundary in the model prompt.
  return buildUntrustedEnvelope(label, JSON.stringify(value) ?? "null");
};

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const normalizedJsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value) ?? "null") as JsonValue;

const escapedJsonStringLength = (value: string): number =>
  escapeUntrustedJson(JSON.stringify(value)).length;

const truncateStringToEscapedBudget = (
  value: string,
  maxCharacters: number,
): string => {
  if (escapedJsonStringLength(value) <= maxCharacters) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (escapedJsonStringLength(candidate) <= maxCharacters) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
};

const compactJsonValue = (
  value: JsonValue,
  maxEscapedStringCharacters: number,
  maxArrayItems: number,
): JsonValue => {
  if (typeof value === "string") {
    return truncateStringToEscapedBudget(value, maxEscapedStringCharacters);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map((item) =>
        compactJsonValue(item, maxEscapedStringCharacters, maxArrayItems),
      );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactJsonValue(item, maxEscapedStringCharacters, maxArrayItems),
      ]),
    );
  }
  return value;
};

const jsonValueMaximums = (
  value: JsonValue,
): { escapedStringCharacters: number; arrayItems: number } => {
  let escapedStringCharacters = 2;
  let arrayItems = 0;
  const visit = (item: JsonValue) => {
    if (typeof item === "string") {
      escapedStringCharacters = Math.max(
        escapedStringCharacters,
        escapedJsonStringLength(item),
      );
      return;
    }
    if (Array.isArray(item)) {
      arrayItems = Math.max(arrayItems, item.length);
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return { escapedStringCharacters, arrayItems };
};

export type BoundedUntrustedContext<T = unknown> = {
  value: T;
  envelope: string;
  characters: number;
  truncated: boolean;
};

/**
 * Applies the hard limit after JSON serialization and delimiter escaping.
 * Short strings are kept intact while the largest strings share the remaining
 * budget. Array tails are removed only when empty string values alone cannot
 * make the structure fit, preserving the most relevant first/recent entries.
 */
export const boundedUntrustedContextEnvelope = <T>(
  label: string,
  value: T,
  maxCharacters: number,
): BoundedUntrustedContext<T> => {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError(
      "Untrusted context budget must be a positive integer.",
    );
  }

  const normalized = normalizedJsonValue(value);
  const fullEnvelope = untrustedContextEnvelope(label, normalized);
  if (fullEnvelope.length <= maxCharacters) {
    return {
      value: normalized as T,
      envelope: fullEnvelope,
      characters: fullEnvelope.length,
      truncated: false,
    };
  }

  const maximums = jsonValueMaximums(normalized);
  const render = (
    stringCharacters: number,
    arrayItems: number,
  ): BoundedUntrustedContext<T> => {
    const compacted = compactJsonValue(
      normalized,
      stringCharacters,
      arrayItems,
    );
    const envelope = untrustedContextEnvelope(label, compacted);
    return {
      value: compacted as T,
      envelope,
      characters: envelope.length,
      truncated: true,
    };
  };

  const emptyStrings = render(2, maximums.arrayItems);
  let arrayLimit = maximums.arrayItems;
  if (emptyStrings.characters > maxCharacters) {
    let low = 0;
    let high = maximums.arrayItems;
    let best = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (render(2, middle).characters <= maxCharacters) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    arrayLimit = best;
  }

  if (arrayLimit >= 0) {
    let low = 2;
    let high = maximums.escapedStringCharacters;
    let best = render(2, arrayLimit);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = render(middle, arrayLimit);
      if (candidate.characters <= maxCharacters) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best.characters <= maxCharacters) return best;
  }

  const sentinel = untrustedContextEnvelope(label, {
    truncated: true,
  });
  if (sentinel.length > maxCharacters) {
    throw new RangeError(
      "Untrusted context budget is too small for a valid envelope.",
    );
  }
  return {
    value: { truncated: true } as T,
    envelope: sentinel,
    characters: sentinel.length,
    truncated: true,
  };
};

export const aiPolicyService = {
  normalizeText: normalizeAiText,
  moderateInput: moderateAiInput,
  containsPromptInjection,
  containsSensitiveAccessSecret,
  hashPublicSessionToken,
  untrustedContextEnvelope,
  boundedUntrustedContextEnvelope,
};
