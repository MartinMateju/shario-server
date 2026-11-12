export const EMAIL_TEMPLATE_CATEGORY = {
  LAYOUT: "layout",
  BOOKING: "booking",
  MEMBERSHIP: "membership",
  REGISTRATION: "registration",
  PASSWORD: "password",
  MARKETING: "marketing",
  GENERAL: "general",
} as const;

export type EmailTemplateCategory =
  (typeof EMAIL_TEMPLATE_CATEGORY)[keyof typeof EMAIL_TEMPLATE_CATEGORY];

export const EMAIL_TEMPLATE_CATEGORIES = Object.values(EMAIL_TEMPLATE_CATEGORY);

export const DEFAULT_EMAIL_TEMPLATE_CATEGORY = EMAIL_TEMPLATE_CATEGORY.GENERAL;
export const DEFAULT_EMAIL_TEMPLATE_PRIMARY_COLOR = "#2563EB";
export const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
export const VARIABLE_REGEX = /{{\s*[\w.]+\s*}}/g;

export const EMAIL_TEMPLATE_LOCALE = {
  CS: "cs",
  EN: "en",
} as const;

export type EmailTemplateLocale =
  (typeof EMAIL_TEMPLATE_LOCALE)[keyof typeof EMAIL_TEMPLATE_LOCALE];

export const EMAIL_TEMPLATE_LOCALES = Object.values(EMAIL_TEMPLATE_LOCALE);
export const DEFAULT_EMAIL_TEMPLATE_LOCALE = EMAIL_TEMPLATE_LOCALE.CS;

export const EMAIL_TEMPLATE_FORMAT = {
  HTML: "html",
  PLAIN: "plain",
} as const;

export type EmailTemplateFormat =
  (typeof EMAIL_TEMPLATE_FORMAT)[keyof typeof EMAIL_TEMPLATE_FORMAT];

export const EMAIL_TEMPLATE_FORMATS = Object.values(EMAIL_TEMPLATE_FORMAT);

export const DEFAULT_EMAIL_TEMPLATE_LIMIT = 100;
export const MAX_EMAIL_TEMPLATE_LIMIT = 300;
