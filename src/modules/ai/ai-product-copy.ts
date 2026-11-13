import { IntlMessageFormat } from "intl-messageformat";
import { resolveAiLocale } from "./ai-locale.js";
import { AI_PRODUCT_MESSAGES } from "./ai-product-messages.js";

const formatters = new Map<string, IntlMessageFormat>();

/** Deterministic product copy uses the requested locale, including during AI outages. */
export const aiProductText = (
  localeValue: unknown,
  key: string,
  values: Record<string, string | number> = {},
): string => {
  const locale = resolveAiLocale(localeValue);
  const message = AI_PRODUCT_MESSAGES[locale]?.[key];
  if (typeof message !== "string") {
    throw new Error(`Missing AI product translation: ${locale}.${key}`);
  }
  const cacheKey = `${locale}:${key}`;
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(message, locale);
    formatters.set(cacheKey, formatter);
  }
  return String(formatter.format(values));
};
