const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;
const NON_VISIBLE_NAME_PATTERN = /[\p{Cf}\p{M}\s]/gu;
const WHITESPACE_PATTERN = /\s+/g;

export const normalizeProductClassCategoryName = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .replace(WHITESPACE_PATTERN, " ")
    .normalize("NFC");

export const getProductClassCategoryNameKey = (value: unknown): string =>
  normalizeProductClassCategoryName(value)
    .normalize("NFD")
    .replace(COMBINING_MARKS_PATTERN, "")
    .toLocaleLowerCase("en")
    .normalize("NFC");

export const hasVisibleProductClassCategoryName = (value: unknown): boolean =>
  getProductClassCategoryNameKey(value).replace(NON_VISIBLE_NAME_PATTERN, "")
    .length > 0;
