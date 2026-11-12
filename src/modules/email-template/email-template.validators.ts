import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_EMAIL_TEMPLATE_CATEGORY,
  DEFAULT_EMAIL_TEMPLATE_LIMIT,
  DEFAULT_EMAIL_TEMPLATE_LOCALE,
  DEFAULT_EMAIL_TEMPLATE_PRIMARY_COLOR,
  EMAIL_TEMPLATE_CATEGORIES,
  EMAIL_TEMPLATE_FORMAT,
  EMAIL_TEMPLATE_FORMATS,
  EMAIL_TEMPLATE_LOCALES,
  HEX_COLOR_REGEX,
  MAX_EMAIL_TEMPLATE_LIMIT,
} from "./email-template.constants.js";
import {
  extractEmailTemplateVariables,
  getUnknownEmailTemplateVariables,
  normalizeEmailLocale,
  sanitizeEmailHtml,
  type LocalizedEmailContent,
} from "./email-template.rendering.js";

const MAX_CONTENT_LENGTH = 250_000;
const MAX_LAYOUT_CONTENT_LENGTH = 100_000;

const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const booleanFromQuerySchema = z.preprocess((value) => {
  if (value === "all" || value === undefined || value === null || value === "") {
    return value;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.union([z.boolean(), z.literal("all")]).default("all"));

const booleanFromBodySchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const optionalString = (maximum: number) =>
  z.preprocess(
    (value) => (value === null || value === undefined ? undefined : value),
    z.string().trim().max(maximum).optional(),
  );

const optionalHtml = (maximum: number) =>
  z.preprocess(
    (value) => (value === null || value === undefined ? undefined : value),
    z.string().max(maximum).optional(),
  );

const isSafeLogoUrl = (value: string): boolean => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const normalizePayloadLocale = (value: unknown): unknown => {
  if (value === undefined || value === null || value === "") return value;
  return normalizeEmailLocale(value);
};

const canonicalizeVariant = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return {
    ...source,
    htmlContent: source.htmlContent ?? source.bodyHtml,
    body: source.body ?? source.bodyText,
  };
};

/** Accept the canonical API contract and the editor's legacy field aliases. */
const canonicalizeTemplatePayload = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const rawVariants =
    (source.contentVariants && typeof source.contentVariants === "object"
      ? source.contentVariants
      : source.variants && typeof source.variants === "object"
        ? source.variants
        : undefined) as Record<string, unknown> | undefined;
  const contentVariants = rawVariants
    ? {
        ...(rawVariants.cs !== undefined
          ? { cs: canonicalizeVariant(rawVariants.cs) }
          : rawVariants.cz !== undefined
            ? { cs: canonicalizeVariant(rawVariants.cz) }
            : {}),
        ...(rawVariants.en !== undefined
          ? { en: canonicalizeVariant(rawVariants.en) }
          : {}),
      }
    : undefined;

  const normalized: Record<string, unknown> = { ...source };
  if (
    Object.prototype.hasOwnProperty.call(source, "defaultLocale") ||
    Object.prototype.hasOwnProperty.call(source, "defaultLanguage")
  ) {
    normalized.defaultLocale = source.defaultLocale ?? source.defaultLanguage;
  }
  if (
    Object.prototype.hasOwnProperty.call(source, "htmlContent") ||
    Object.prototype.hasOwnProperty.call(source, "bodyHtml")
  ) {
    normalized.htmlContent = source.htmlContent ?? source.bodyHtml;
  }
  if (
    Object.prototype.hasOwnProperty.call(source, "body") ||
    Object.prototype.hasOwnProperty.call(source, "bodyText")
  ) {
    normalized.body = source.body ?? source.bodyText;
  }
  if (contentVariants) normalized.contentVariants = contentVariants;
  return normalized;
};

export const emailTemplateCategorySchema = z.enum(
  EMAIL_TEMPLATE_CATEGORIES as [string, ...string[]],
);

const emailTemplateLocaleSchema = z.preprocess(
  normalizePayloadLocale,
  z.enum(EMAIL_TEMPLATE_LOCALES),
);

const localizedContentObjectSchema = z
  .object({
    subject: optionalString(200),
    htmlContent: optionalHtml(MAX_CONTENT_LENGTH),
    body: optionalHtml(MAX_CONTENT_LENGTH),
    format: z.enum(EMAIL_TEMPLATE_FORMATS).optional(),
  })
  .superRefine((value, ctx) => {
    const hasAnyContent = Boolean(value.subject || value.htmlContent || value.body);
    if (!hasAnyContent) return;
    if (!value.subject) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: "A subject is required for every localized email variant.",
      });
    }
    if (!value.htmlContent && !value.body) {
      ctx.addIssue({
        code: "custom",
        path: ["htmlContent"],
        message: "HTML or plain-text content is required for every localized variant.",
      });
    }
  })
  .transform((value) => {
    const format =
      value.format ??
      (value.htmlContent ? EMAIL_TEMPLATE_FORMAT.HTML : EMAIL_TEMPLATE_FORMAT.PLAIN);
    return {
      subject: value.subject ?? "",
      htmlContent: value.htmlContent ? sanitizeEmailHtml(value.htmlContent).trim() : "",
      body: value.body?.trim() ?? "",
      format,
    };
  });

export const localizedEmailTemplateContentSchema = localizedContentObjectSchema;

const contentVariantsSchema = z
  .object({
    cs: localizedContentObjectSchema.optional(),
    en: localizedContentObjectSchema.optional(),
  })
  .optional();

const emailTemplatePayloadObjectSchema = z.object({
  name: optionalString(120),
  description: optionalString(500),
  subject: optionalString(200),
  htmlContent: optionalHtml(MAX_CONTENT_LENGTH),
  body: optionalHtml(MAX_CONTENT_LENGTH),
  format: z.enum(EMAIL_TEMPLATE_FORMATS).optional(),
  defaultLocale: emailTemplateLocaleSchema.optional(),
  contentVariants: contentVariantsSchema,
  headerHtml: optionalHtml(MAX_LAYOUT_CONTENT_LENGTH),
  footerHtml: optionalHtml(MAX_LAYOUT_CONTENT_LENGTH),
  logoUrl: optionalString(1000).refine(
    (value) => value === undefined || isSafeLogoUrl(value),
    "Logo URL must use HTTP or HTTPS.",
  ),
  primaryColor: optionalString(7).refine(
    (value) => value === undefined || HEX_COLOR_REGEX.test(value),
    "Primary color must be a valid HEX color.",
  ),
  category: emailTemplateCategorySchema.optional(),
  isDefault: booleanFromBodySchema.optional(),
  isActive: booleanFromBodySchema.optional(),
});

type ParsedTemplatePayload = z.infer<typeof emailTemplatePayloadObjectSchema>;

const allContentValues = (value: ParsedTemplatePayload): unknown[] => [
  value.subject,
  value.htmlContent,
  value.body,
  value.headerHtml,
  value.footerHtml,
  ...Object.values(value.contentVariants ?? {}).flatMap((variant) => [
    variant?.subject,
    variant?.htmlContent,
    variant?.body,
  ]),
];

const addCommonPayloadIssues = (
  value: ParsedTemplatePayload,
  ctx: z.RefinementCtx,
): void => {
  if (value.isDefault && value.isActive === false) {
    ctx.addIssue({
      code: "custom",
      path: ["isActive"],
      message: "A default email template must be active.",
    });
  }

  const unknown = getUnknownEmailTemplateVariables(...allContentValues(value));
  if (unknown.length) {
    ctx.addIssue({
      code: "custom",
      path: ["contentVariants"],
      message: `Unsupported email variables: ${unknown.join(", ")}.`,
    });
  }
};

const hasCompleteContent = (value: ParsedTemplatePayload): boolean => {
  if (value.subject && (value.htmlContent || value.body)) return true;
  return Object.values(value.contentVariants ?? {}).some(
    (variant) => variant?.subject && (variant.htmlContent || variant.body),
  );
};

const normalizeTemplatePayload = (
  value: ParsedTemplatePayload,
  create: boolean,
): Record<string, unknown> => {
  const contentVariants = value.contentVariants;
  const defaultLocale =
    value.defaultLocale ?? (create ? DEFAULT_EMAIL_TEMPLATE_LOCALE : undefined);
  const variantLocale =
    defaultLocale && contentVariants?.[defaultLocale]
      ? defaultLocale
      : contentVariants?.cs
        ? "cs"
        : contentVariants?.en
          ? "en"
          : undefined;
  const primaryVariant = variantLocale ? contentVariants?.[variantLocale] : undefined;

  const normalized: Record<string, unknown> = {
    ...value,
    ...(create
      ? {
          name: value.name || "Untitled template",
          description: value.description ?? "",
          subject: value.subject ?? primaryVariant?.subject ?? "",
          htmlContent: value.htmlContent
            ? sanitizeEmailHtml(value.htmlContent).trim()
            : primaryVariant?.htmlContent ?? "",
          body: value.body?.trim() ?? primaryVariant?.body ?? "",
          format:
            value.format ??
            primaryVariant?.format ??
            (value.htmlContent
              ? EMAIL_TEMPLATE_FORMAT.HTML
              : EMAIL_TEMPLATE_FORMAT.PLAIN),
          defaultLocale,
          headerHtml: sanitizeEmailHtml(value.headerHtml ?? "").trim(),
          footerHtml: sanitizeEmailHtml(value.footerHtml ?? "").trim(),
          logoUrl: value.logoUrl ?? "",
          primaryColor:
            value.primaryColor ?? DEFAULT_EMAIL_TEMPLATE_PRIMARY_COLOR,
          category: value.category ?? DEFAULT_EMAIL_TEMPLATE_CATEGORY,
          isDefault: value.isDefault ?? false,
          isActive: value.isActive ?? true,
        }
      : {
          ...(value.htmlContent !== undefined
            ? { htmlContent: sanitizeEmailHtml(value.htmlContent).trim() }
            : {}),
          ...(value.body !== undefined
            ? { body: value.body.trim() }
            : {}),
          ...(value.subject !== undefined
            ? { subject: value.subject }
            : {}),
          ...(value.headerHtml !== undefined
            ? { headerHtml: sanitizeEmailHtml(value.headerHtml).trim() }
            : {}),
          ...(value.footerHtml !== undefined
            ? { footerHtml: sanitizeEmailHtml(value.footerHtml).trim() }
            : {}),
        }),
  };

  const variables = extractEmailTemplateVariables(
    ...allContentValues(normalized as ParsedTemplatePayload),
  );
  const contentWasUpdated = [
    "subject",
    "htmlContent",
    "body",
    "headerHtml",
    "footerHtml",
    "contentVariants",
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));

  if (create || contentWasUpdated) normalized.variables = variables;
  return normalized;
};

export const createEmailTemplateSchema = z
  .preprocess(canonicalizeTemplatePayload, emailTemplatePayloadObjectSchema)
  .superRefine((value, ctx) => {
    addCommonPayloadIssues(value, ctx);
    const category = value.category ?? DEFAULT_EMAIL_TEMPLATE_CATEGORY;
    if (category !== "layout" && !hasCompleteContent(value)) {
      ctx.addIssue({
        code: "custom",
        path: ["contentVariants"],
        message: "At least one complete localized email variant is required.",
      });
    }
  })
  .transform((value) => normalizeTemplatePayload(value, true));

export const updateEmailTemplateSchema = z
  .preprocess(canonicalizeTemplatePayload, emailTemplatePayloadObjectSchema)
  .superRefine(addCommonPayloadIssues)
  .transform((value) => normalizeTemplatePayload(value, false));

export const emailTemplateIdParamsSchema = z.object({
  id: objectIdSchema("template id"),
});

export const listEmailTemplatesQuerySchema = z.object({
  search: optionalString(200).default(""),
  category: z.union([emailTemplateCategorySchema, z.literal("all")]).default("all"),
  active: booleanFromQuerySchema,
  type: z.enum(["all", "layout", "content"]).default("all"),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_EMAIL_TEMPLATE_LIMIT)
    .default(DEFAULT_EMAIL_TEMPLATE_LIMIT),
});

export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateSchema>;
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;
export type ListEmailTemplatesQuery = z.infer<typeof listEmailTemplatesQuerySchema>;
export type LocalizedEmailTemplateContentInput = LocalizedEmailContent;
