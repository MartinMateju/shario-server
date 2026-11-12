import { resolveCommunicationContentLocale } from "@/shared/i18n/communication-locales.js";

import {
  DEFAULT_EMAIL_TEMPLATE_LOCALE,
  EMAIL_TEMPLATE_FORMAT,
  type EmailTemplateFormat,
  type EmailTemplateLocale,
} from "./email-template.constants.js";

/**
 * This is the single allowlist shared by template validation and runtime
 * rendering. Adding a variable here is an API change: the delivery worker must
 * also provide it before templates are allowed to persist it.
 */
export const EMAIL_TEMPLATE_VARIABLES = Object.freeze([
  "firstName",
  "lastName",
  "fullName",
  "email",
  "customId",
  "date",
  "time",
  "studioName",
  "studioAddress",
  "studioEmail",
  "studioPhone",
  "logo",
  // Legacy alias retained for existing automations.
  "studio",
  "bookingDate",
  "bookingTime",
  "productName",
  "orderNumber",
  "totalPrice",
] as const);

export type EmailContentLocale = EmailTemplateLocale;

export type LocalizedEmailContent = {
  subject?: string;
  htmlContent?: string;
  body?: string;
  format?: EmailTemplateFormat;
};

export type LocalizedEmailSource = LocalizedEmailContent & {
  defaultLocale?: EmailContentLocale | "cz" | "CZ" | "CS" | "EN";
  contentVariants?: Partial<Record<EmailContentLocale, LocalizedEmailContent>>;
};

const VARIABLE_PATTERN = /{{\s*([\w.]+)\s*}}/g;
const allowedVariableSet = new Set<string>(EMAIL_TEMPLATE_VARIABLES);

const hasContent = (content: LocalizedEmailContent | undefined): boolean =>
  Boolean(
    content &&
      (String(content.subject ?? "").trim() ||
        String(content.htmlContent ?? "").trim() ||
        String(content.body ?? "").trim()),
  );

export const normalizeEmailLocale = (value: unknown): EmailContentLocale => {
  return resolveCommunicationContentLocale(
    value,
    DEFAULT_EMAIL_TEMPLATE_LOCALE,
  );
};

export const extractEmailTemplateVariables = (...values: unknown[]): string[] => {
  const found = new Set<string>();

  for (const value of values) {
    const source = String(value ?? "");
    for (const match of source.matchAll(VARIABLE_PATTERN)) {
      if (match[1]) found.add(match[1]);
    }
  }

  return [...found];
};

export const getUnknownEmailTemplateVariables = (...values: unknown[]): string[] =>
  extractEmailTemplateVariables(...values).filter(
    (variable) => !allowedVariableSet.has(variable),
  );

export const assertValidEmailTemplateVariables = (...values: unknown[]): void => {
  const unknown = getUnknownEmailTemplateVariables(...values);
  if (unknown.length) {
    throw new Error(`Unsupported email variables: ${unknown.join(", ")}.`);
  }
};

export const escapeEmailHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);
const GLOBAL_ATTRIBUTES = new Set([
  "align",
  "bgcolor",
  "class",
  "dir",
  "height",
  "lang",
  "style",
  "title",
  "valign",
  "width",
]);
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "rel", "target"]),
  img: new Set(["alt", "src"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};
const URL_ATTRIBUTES = new Set(["href", "src"]);
const ALLOWED_STYLE_PROPERTIES = new Set([
  "background-color",
  "border",
  "border-bottom",
  "border-color",
  "border-left",
  "border-radius",
  "border-right",
  "border-style",
  "border-top",
  "border-width",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-width",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
]);

const decodeUrlEntities = (value: string): string =>
  value
    .replace(/&#(\d+);?/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&#x([\da-f]+);?/gi, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/&(colon|tab|newline);?/gi, (_match, name: string) => {
      if (name.toLowerCase() === "colon") return ":";
      if (name.toLowerCase() === "tab") return "\t";
      return "\n";
    })
    .replace(/&amp;/gi, "&");

const isSafeEmailUrl = (value: string, attribute: string): boolean => {
  const normalized = decodeUrlEntities(value)
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();

  if (!normalized || normalized.startsWith("#") || normalized.startsWith("{{")) {
    return true;
  }

  if (attribute === "src") {
    return /^(https?:|cid:|\/)/.test(normalized);
  }

  return /^(https?:|mailto:|tel:|\/)/.test(normalized);
};

const sanitizeInlineStyle = (value: string): string =>
  value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .flatMap((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 1) return [];

      const property = declaration.slice(0, separator).trim().toLowerCase();
      const propertyValue = declaration.slice(separator + 1).trim();
      const unsafeValue =
        /(?:expression\s*\(|url\s*\(|@import|javascript:|vbscript:|behavior\s*:|-moz-binding|\\)/i.test(
          propertyValue,
        );

      if (
        !ALLOWED_STYLE_PROPERTIES.has(property) ||
        !propertyValue ||
        propertyValue.length > 500 ||
        unsafeValue
      ) {
        return [];
      }

      return [`${property}: ${propertyValue.replace(/[<>"']/g, "")}`];
    })
    .join("; ");

const sanitizeTag = (token: string): string => {
  const closingMatch = token.match(/^<\s*\/\s*([a-z0-9]+)[^>]*>$/i);
  if (closingMatch) {
    const tag = closingMatch[1].toLowerCase();
    return ALLOWED_TAGS.has(tag) && !VOID_TAGS.has(tag) ? `</${tag}>` : "";
  }

  const openingMatch = token.match(/^<\s*([a-z0-9]+)\b([\s\S]*?)\/?\s*>$/i);
  if (!openingMatch) return "";

  const tag = openingMatch[1].toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return "";

  const allowedForTag = TAG_ATTRIBUTES[tag] ?? new Set<string>();
  const attributes: string[] = [];
  const attributePattern = /([a-zA-Z][\w:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of openingMatch[2].matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if (!GLOBAL_ATTRIBUTES.has(name) && !allowedForTag.has(name)) continue;

    let value = match[2] ?? match[3] ?? match[4] ?? "";
    if (URL_ATTRIBUTES.has(name) && !isSafeEmailUrl(value, name)) continue;
    if (name === "style") {
      value = sanitizeInlineStyle(value);
      if (!value) continue;
    }
    if (name === "target" && !["_blank", "_self"].includes(value)) continue;
    if (name === "rel") {
      value = value
        .split(/\s+/)
        .filter((part) => ["noopener", "noreferrer"].includes(part.toLowerCase()))
        .join(" ");
      if (!value) continue;
    }

    attributes.push(`${name}="${escapeEmailHtml(value)}"`);
  }

  // Links opened in a new browsing context must not retain opener access.
  const opensNewContext = attributes.includes('target="_blank"');
  const hasRel = attributes.some((attribute) => attribute.startsWith("rel="));
  if (tag === "a" && opensNewContext && !hasRel) {
    attributes.push('rel="noopener noreferrer"');
  }

  return `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
};

/**
 * Sanitize administrator-authored HTML using an explicit email-safe allowlist.
 * The implementation intentionally removes executable and document-level
 * elements before rebuilding every remaining tag and attribute from scratch.
 */
export const sanitizeEmailHtml = (value: unknown): string => {
  let source = String(value ?? "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<!\s*(?:doctype|entity)[^>]*>/gi, "");

  const blockedElements =
    /<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let previous = "";
  while (previous !== source) {
    previous = source;
    source = source.replace(blockedElements, "");
  }

  source = source.replace(
    /<(script|style|iframe|object|embed|form|input|button|textarea|select|option|meta|link|base|svg|math)\b[^>]*\/?\s*>/gi,
    "",
  );

  return source.replace(/<[^>]*>/g, sanitizeTag);
};

export const emailHtmlToPlainText = (value: unknown): string =>
  String(value ?? "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const getVariableValue = (
  data: Record<string, unknown>,
  key: string,
): unknown => {
  if (Object.prototype.hasOwnProperty.call(data, key)) return data[key];

  return key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return "";
    return (current as Record<string, unknown>)[segment];
  }, data);
};

const replaceVariables = (
  source: string,
  data: Record<string, unknown>,
  escape: (value: unknown) => string,
): string =>
  source.replace(VARIABLE_PATTERN, (_match, key: string) =>
    escape(getVariableValue(data, key)),
  );

export const selectLocalizedEmailContent = (
  source: LocalizedEmailSource,
  requestedLocale: unknown,
): Required<LocalizedEmailContent> & { locale: EmailContentLocale } => {
  const requested = normalizeEmailLocale(requestedLocale);
  const defaultLocale = normalizeEmailLocale(source.defaultLocale);
  const candidates: Array<[EmailContentLocale, LocalizedEmailContent | undefined]> = [
    [requested, source.contentVariants?.[requested]],
    [defaultLocale, source.contentVariants?.[defaultLocale]],
    ["cs", source.contentVariants?.cs],
    ["en", source.contentVariants?.en],
  ];
  const selectedEntry = candidates.find(([, content]) => hasContent(content));
  const selected = selectedEntry?.[1] ?? source;
  const locale = selectedEntry?.[0] ?? defaultLocale;
  const subject = String(selected.subject || source.subject || "");
  const explicitHtml = String(selected.htmlContent || source.htmlContent || "");
  const body = String(selected.body || source.body || "");
  const format =
    selected.format ||
    source.format ||
    (explicitHtml ? EMAIL_TEMPLATE_FORMAT.HTML : EMAIL_TEMPLATE_FORMAT.PLAIN);

  return {
    locale,
    subject,
    // Keep body as an htmlContent fallback for legacy consumers. The renderer
    // still uses format to escape plain-text content correctly.
    htmlContent: explicitHtml || body,
    body,
    format,
  };
};

export const hasDeliverableEmailTemplateContent = (
  source: LocalizedEmailSource & { category?: unknown },
): boolean => {
  if (source.category === "layout") return false;
  const selected = selectLocalizedEmailContent(source, source.defaultLocale);
  return Boolean(
    selected.subject.trim() &&
      String(selected.htmlContent || selected.body || "").trim(),
  );
};

export const renderEmailContent = ({
  source,
  locale,
  variables,
}: {
  source: LocalizedEmailSource;
  locale: unknown;
  variables: Record<string, unknown>;
}): { locale: EmailContentLocale; subject: string; html: string; text: string } => {
  const selected = selectLocalizedEmailContent(source, locale);
  assertValidEmailTemplateVariables(
    selected.subject,
    selected.htmlContent,
    selected.body,
  );

  const subject = replaceVariables(selected.subject, variables, (value) =>
    String(value ?? "").replace(/[\r\n]+/g, " ").trim(),
  )
    .replace(/[\r\n]+/g, " ")
    .trim();
  let html = "";
  let text = "";

  if (selected.format === EMAIL_TEMPLATE_FORMAT.PLAIN) {
    text = replaceVariables(selected.body || selected.htmlContent, variables, (value) =>
      String(value ?? ""),
    ).trim();
    html = escapeEmailHtml(text).replace(/\r?\n/g, "<br>");
  } else {
    html = sanitizeEmailHtml(
      replaceVariables(selected.htmlContent, variables, escapeEmailHtml),
    ).trim();
    text = replaceVariables(selected.body, variables, (value) =>
      String(value ?? ""),
    ).trim();
    if (!text) text = emailHtmlToPlainText(html);
  }

  if (!subject) throw new Error("Email subject is empty after rendering.");
  if (!html) throw new Error("Email content is empty after rendering.");

  return {
    locale: selected.locale,
    subject,
    html,
    text,
  };
};
