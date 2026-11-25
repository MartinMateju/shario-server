import { z } from "zod";
import {
  emailHtmlToPlainText,
  escapeEmailHtml,
  sanitizeEmailHtml,
} from "@/modules/email-template/email-template.rendering.js";
import { resolveCommunicationContentLocale } from "@/shared/i18n/communication-locales.js";

// Credentials are intentionally unavailable to ordinary email templates.
export const DOOR_ACCESS_EMAIL_VARIABLES = [
  "entryCode",
  "studioName",
  "studioAddress",
  "bookingTime",
  "bookingUrl",
] as const;
type DoorAccessVariable = (typeof DOOR_ACCESS_EMAIL_VARIABLES)[number];
const variables = new Set<string>(DOOR_ACCESS_EMAIL_VARIABLES);
const tokenPattern = /{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g;
const codePattern = /{{\s*entryCode\s*}}/;

// The shared sanitizer rebuilds attributes with escaping. Preserve existing
// entity references within those rebuilt tags so validating a saved template
// again does not turn a query separator into the literal text "&amp;".
const sanitizeDoorEmailHtml = (source: string): string =>
  sanitizeEmailHtml(source).replace(/<[^>]*>/g, (tag) =>
    tag.replace(/&amp;((?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, "&$1"),
  );

const variableError = (source: string): string | null => {
  for (const match of source.matchAll(tokenPattern)) {
    if (!variables.has(match[1]))
      return `Unsupported door-email variable: ${match[1]}.`;
  }
  if (/[{}]/.test(source.replace(tokenPattern, "")))
    return "Use complete variables such as {{entryCode}}.";
  return null;
};

const codeInUrl = (source: string): boolean => {
  const marked = source.replace(
    /{{\s*entryCode\s*}}/g,
    "SHARIO_ENTRY_CODE_TOKEN",
  );
  return (
    /(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)[^\s<>"']*SHARIO_ENTRY_CODE_TOKEN/i.test(
      marked,
    ) || /[^\s<>"']*SHARIO_ENTRY_CODE_TOKEN[^\s<>"']*@[^\s<>"']+/i.test(marked)
  );
};

const variantSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    format: z.enum(["plain", "html"]),
    htmlContent: z.string().max(50_000).default(""),
    body: z.string().max(20_000).default(""),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (
      field: "subject" | "htmlContent" | "body",
      message: string,
    ) => ctx.addIssue({ code: "custom", path: [field], message });
    for (const field of ["subject", "htmlContent", "body"] as const) {
      const error = variableError(value[field]);
      if (error) issue(field, error);
      if (codeInUrl(value[field]))
        issue(field, "The entry code cannot appear in a URL or email address.");
    }
    if (/[\r\n]/.test(value.subject))
      issue("subject", "The subject must be a single line.");
    if (codePattern.test(value.subject))
      issue(
        "subject",
        "Keep {{entryCode}} in the message body, not the subject.",
      );
    if (value.format === "plain") {
      if (!codePattern.test(value.body))
        issue("body", "The message must include {{entryCode}}.");
      return;
    }
    // Validate the effective sanitized body, so a token in a comment or script
    // cannot satisfy the requirement. No token may smuggle a credential into an
    // attribute; bookingUrl is the only supported dynamic link target.
    for (const tag of value.htmlContent.match(/<[^>]*>/g) || []) {
      if (codePattern.test(tag))
        issue(
          "htmlContent",
          "The entry code cannot appear in an HTML attribute.",
        );
      for (const match of tag.matchAll(tokenPattern)) {
        if (
          match[1] !== "bookingUrl" ||
          !/\bhref\s*=\s*(["']){{\s*bookingUrl\s*}}\1/i.test(tag)
        )
          issue(
            "htmlContent",
            "Only {{bookingUrl}} may be used in an HTML attribute, as a complete link URL.",
          );
      }
    }
    const html = sanitizeDoorEmailHtml(value.htmlContent);
    const visibleText = emailHtmlToPlainText(html);
    if (codeInUrl(visibleText))
      issue(
        "htmlContent",
        "The entry code cannot appear in a URL or email address.",
      );
    if (!codePattern.test(visibleText))
      issue("htmlContent", "The visible message must include {{entryCode}}.");
    if (/[<>]/.test(html.replace(/<[^>]*>/g, "")))
      issue(
        "htmlContent",
        "Close HTML tags and escape literal angle brackets.",
      );
    if (
      /display\s*:\s*none\b|font-size\s*:\s*(?:0+(?:\.0*)?|\.0+)\s*(?:[a-z%]+)?(?:[;"']|$)|color\s*:\s*transparent\b/i.test(
        html,
      )
    )
      issue(
        "htmlContent",
        "Door-code messages cannot hide content with invisible styles.",
      );
    if (value.body.trim() && !codePattern.test(value.body))
      issue(
        "body",
        "The plain-text alternative must also include {{entryCode}}.",
      );
  })
  .transform((value) => ({
    ...value,
    htmlContent:
      value.format === "html"
        ? sanitizeDoorEmailHtml(value.htmlContent).trim()
        : "",
    body: value.body.trim(),
  }));

export const doorAccessEmailTemplateSchema = z
  .object({
    defaultLocale: z.enum(["cs", "en"]),
    contentVariants: z
      .object({
        cs: variantSchema.optional(),
        en: variantSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.contentVariants[value.defaultLocale])
      ctx.addIssue({
        code: "custom",
        path: ["contentVariants", value.defaultLocale],
        message: "Provide the default language's subject and message.",
      });
  });

export type DoorAccessEmailTemplate = z.infer<
  typeof doorAccessEmailTemplateSchema
>;
export type DoorAccessEmailVariables = Record<DoorAccessVariable, string>;

const defaultVariant = (english: boolean) => ({
  subject: `{{studioName}} | ${english ? "Entry code" : "Vstupní kód"} 🔑`,
  format: "html" as const,
  htmlContent: `<h1 style="margin:0 0 20px;font-size:28px;line-height:1.3;color:inherit;">${english ? "Your studio entry code" : "Váš vstupní kód do ateliéru"}</h1>
<p>${english ? "Your booking starts soon. Here is your code for" : "Vaše rezervace brzy začíná. Zde je váš kód pro"} <strong>{{studioName}}</strong>.</p>
<div style="margin:24px 0;padding:24px;border:1px solid #d8d4cb;border-radius:12px;text-align:center;">
<p style="margin:0 0 10px;font-size:13px;">${english ? "DOOR ACCESS CODE" : "VSTUPNÍ KÓD"}</p>
<p style="margin:0;font-family:monospace;font-size:34px;font-weight:bold;letter-spacing:4px;overflow-wrap:anywhere;">{{entryCode}}</p></div>
<p><strong>${english ? "Booking" : "Rezervace"}:</strong> {{bookingTime}}</p>
<p><strong>${english ? "Address" : "Adresa"}:</strong> {{studioAddress}}</p>
<p>${english ? "Please keep this code private and use it only for your booked studio visit." : "Kód prosím nesdílejte a používejte jej pouze při své rezervované návštěvě ateliéru."}</p>
<p><a href="{{bookingUrl}}">${english ? "Manage booking" : "Spravovat rezervaci"}</a></p>`,
  body: [
    english ? "Hello," : "Dobrý den,",
    "",
    english
      ? "Your entry code is: {{entryCode}}"
      : "váš vstupní kód je: {{entryCode}}",
    "",
    "Studio: {{studioName}}",
    `${english ? "Address" : "Adresa"}: {{studioAddress}}`,
    `${english ? "Booking" : "Rezervace"}: {{bookingTime}}`,
    `${english ? "Manage booking" : "Spravovat rezervaci"}: {{bookingUrl}}`,
    "",
    english
      ? "This email was sent automatically."
      : "Tento e-mail byl odeslán automaticky.",
  ].join("\n"),
});

/** Virtual editable defaults: no location writes and no live access inventory. */
export const defaultDoorAccessEmailTemplate = (): DoorAccessEmailTemplate => ({
  defaultLocale: "cs",
  contentVariants: { cs: defaultVariant(false), en: defaultVariant(true) },
});

export const renderDoorAccessEmailTemplate = (
  source: DoorAccessEmailTemplate,
  locale: unknown,
  values: DoorAccessEmailVariables,
): { subject: string; html: string; text: string } => {
  const validated = doorAccessEmailTemplateSchema.parse(source);
  const requested = resolveCommunicationContentLocale(
    locale,
    validated.defaultLocale,
  );
  const selected =
    validated.contentVariants[requested] ||
    validated.contentVariants[validated.defaultLocale]!;
  const replace = (text: string, escape: (value: string) => string) =>
    text.replace(tokenPattern, (_match, key: DoorAccessVariable) =>
      escape(values[key] || ""),
    );
  const subject = replace(selected.subject, (value) =>
    value.replace(/[\r\n]+/g, " "),
  ).trim();
  if (selected.format === "plain") {
    const text = replace(selected.body, (value) => value).trim();
    return {
      subject,
      text,
      html: escapeEmailHtml(text).replace(/\r?\n/g, "<br>"),
    };
  }
  const html = sanitizeDoorEmailHtml(
    replace(selected.htmlContent, escapeEmailHtml),
  );
  const text = selected.body
    ? replace(selected.body, (value) => value)
    : emailHtmlToPlainText(html);
  return { subject, html, text };
};
