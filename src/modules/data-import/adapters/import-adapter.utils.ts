export const importValueAt = <Field extends string>(
  raw: Record<string, string>,
  mapping: Partial<Record<Field, string>>,
  field: Field,
): string => String(mapping[field] ? (raw[mapping[field]!] ?? "") : "").trim();

export const importToken = (value: string): string =>
  String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\s]+/g, "-");

export const parseImportAmount = (input: string): number | null => {
  const compact = String(input || "")
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "");
  if (!compact || !/^-?[0-9.,]+$/.test(compact)) return null;
  const sign = compact.startsWith("-") ? -1 : 1;
  const value = compact.replace(/^-/, "");
  const dots = [...value.matchAll(/\./g)].map((match) => match.index!);
  const commas = [...value.matchAll(/,/g)].map((match) => match.index!);
  let normalized: string;
  if (dots.length && commas.length) {
    const decimal = dots.at(-1)! > commas.at(-1)! ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    if ((decimal === "." ? dots : commas).length !== 1) return null;
    const [whole, fraction = ""] = value.split(decimal);
    if (!/^\d{1,3}(?:[.,]\d{3})+$/.test(whole) || !/^\d{1,2}$/.test(fraction))
      return null;
    if (whole.includes(decimal) || whole.split(grouping).some((part) => !part))
      return null;
    normalized = `${whole.split(grouping).join("")}.${fraction}`;
  } else {
    const separator = dots.length ? "." : commas.length ? "," : "";
    if (!separator) normalized = value;
    else {
      const parts = value.split(separator);
      if (parts.some((part) => !/^\d+$/.test(part))) return null;
      if (parts.length > 2) {
        if (
          parts[0].length < 1 ||
          parts[0].length > 3 ||
          parts.slice(1).some((part) => part.length !== 3)
        )
          return null;
        normalized = parts.join("");
      } else {
        const [whole, tail] = parts;
        if (!tail) return null;
        if (tail.length === 3 && whole !== "0") return null;
        if (tail.length > 3) return null;
        normalized = `${whole}.${tail}`;
      }
    }
  }
  const parsed = Number(normalized) * sign;
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseImportInteger = (value: string): number | null => {
  if (!/^-?\d+$/.test(String(value || "").trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const parseImportBoolean = (value: string): boolean | null => {
  const token = importToken(value);
  if (["true", "yes", "y", "1", "ano", "active", "enabled"].includes(token))
    return true;
  if (["false", "no", "n", "0", "ne", "inactive", "disabled"].includes(token))
    return false;
  return null;
};

const validCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toISOString().slice(0, 10) === value;
};

export const parseImportDateTime = (
  value: string,
  edge: "start" | "end" = "start",
): string => {
  const input = String(value || "").trim();
  if (!input) return "";
  if (validCalendarDate(input))
    return edge === "end" ? `${input}T23:59:59.999Z` : `${input}T00:00:00.000Z`;
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(input) ||
    !/(?:Z|[+-]\d{2}:?\d{2})$/.test(input)
  )
    return "";
  if (!validCalendarDate(input.slice(0, 10))) return "";
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};

export const parseJsonArray = (value: string): unknown[] | null => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const parseNonnegativeIntegerMap = (
  value: string,
): Record<string, number> | null => {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed);
    if (
      entries.some(
        ([key, amount]) =>
          !key.trim() || !Number.isSafeInteger(amount) || Number(amount) < 0,
      )
    )
      return null;
    return Object.fromEntries(
      entries.map(([key, amount]) => [
        key.trim().toLocaleLowerCase(),
        Number(amount),
      ]),
    );
  } catch {
    return null;
  }
};
