import type {
  ImportIssue,
  NormalizedProductImportRow,
  ProductImportColumnMapping,
} from "../data-import.types.js";
import {
  getCurrencyExponent,
  isStudioCommerceCurrency,
} from "@/shared/money/currency.js";

const valueAt = (
  raw: Record<string, string>,
  mapping: ProductImportColumnMapping,
  field: keyof ProductImportColumnMapping,
): string =>
  String(mapping[field] ? raw[mapping[field] as string] || "" : "").trim();

const normalizeToken = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[_\s]+/g, "-");

export const parseImportNumber = (value: string): number | null => {
  let normalized = value.replace(/[\s\u00a0]/g, "").trim();
  if (!normalized) return null;
  if (!/^[+-]?\d+(?:[.,]\d+)*$/.test(normalized)) return null;
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const grouping = decimal === "," ? "." : ",";
    if (normalized.split(decimal).length !== 2) return null;
    const [whole, fraction] = normalized.split(decimal);
    if (!fraction || !/^\d+$/.test(fraction)) return null;
    const unsignedWhole = whole.replace(/^[+-]/, "");
    if (
      unsignedWhole.includes(grouping) &&
      !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(unsignedWhole)
    )
      return null;
    normalized = `${whole.replaceAll(grouping, "")}.${fraction}`;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const pieces = normalized.split(separator);
    if (pieces.length > 2) {
      const unsigned = normalized.replace(/^[+-]/, "");
      if (!new RegExp(`^\\d{1,3}(?:\\${separator}\\d{3})+$`).test(unsigned))
        return null;
      normalized = normalized.replaceAll(separator, "");
    } else {
      const [whole, fraction = ""] = pieces;
      if (!fraction) return null;
      if (fraction.length === 3 && Number(whole) !== 0) return null;
      normalized = `${whole}.${fraction}`;
    }
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

const parseInteger = (value: string): number | null => {
  const number = parseImportNumber(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
};

const parseBoolean = (value: string): boolean | null => {
  const normalized = normalizeToken(value);
  if (!normalized) return null;
  if (
    ["true", "1", "yes", "y", "ano", "aktivni", "active"].includes(normalized)
  ) {
    return true;
  }
  if (
    ["false", "0", "no", "n", "ne", "neaktivni", "inactive"].includes(
      normalized,
    )
  ) {
    return false;
  }
  return null;
};

type ProductKind = NormalizedProductImportRow["kind"];

const normalizeKind = (value: string): ProductKind => {
  const normalized = normalizeToken(value);
  if (
    [
      "open-studio",
      "openstudio",
      "studio-access",
      "shared-studio",
      "workshop",
      "otevrene-studio",
      "sdilena-dilna",
    ].includes(normalized)
  ) {
    return "open-studio";
  }
  if (
    [
      "class",
      "course",
      "lesson",
      "event",
      "kurz",
      "lekce",
      "udalost",
      "workshop-class",
    ].includes(normalized)
  ) {
    return "class";
  }
  if (
    ["voucher", "gift-card", "giftcard", "poukaz", "darkovy-poukaz"].includes(
      normalized,
    )
  ) {
    return "voucher";
  }
  if (
    ["private-studio", "private-session", "blocker", "interni-blok"].includes(
      normalized,
    )
  ) {
    return "private-studio";
  }
  return "";
};

const typeForKind = (kind: ProductKind): NormalizedProductImportRow["type"] => {
  if (kind === "open-studio") return "workshop";
  if (kind === "class") return "course";
  if (kind === "voucher") return "coupon";
  if (kind === "private-studio") return "blocker";
  return "";
};

const parseEnum = <T extends string>(
  value: string,
  allowed: readonly T[],
): T | null => {
  const normalized = normalizeToken(value);
  return allowed.includes(normalized as T) ? (normalized as T) : null;
};

export const normalizeProductImportRow = (
  raw: Record<string, string>,
  mapping: ProductImportColumnMapping,
  defaultCurrency = "CZK",
): NormalizedProductImportRow => {
  // Only non-empty mapped cells are applied to an existing product. This
  // prevents an update import from blanking optional data unintentionally.
  const providedFields: NormalizedProductImportRow["providedFields"] = [];
  for (const field of Object.keys(mapping) as Array<
    keyof ProductImportColumnMapping
  >) {
    if (mapping[field] && valueAt(raw, mapping, field))
      providedFields.push(field);
  }

  const kindInput = valueAt(raw, mapping, "kind");
  const kind = normalizeKind(kindInput);
  const currency = (
    valueAt(raw, mapping, "currency") || defaultCurrency
  ).toUpperCase();
  const priceRaw = valueAt(raw, mapping, "price");
  const extraChargeRaw = valueAt(raw, mapping, "extraCharge");
  const capacityRaw = valueAt(raw, mapping, "capacity");
  const activeRaw = valueAt(raw, mapping, "isActive");
  const sortRaw = valueAt(raw, mapping, "sortOrder");
  const bookingModeRaw = valueAt(raw, mapping, "bookingMode");
  const parseErrors: NormalizedProductImportRow["parseErrors"] = [];
  const price = priceRaw ? parseImportNumber(priceRaw) : 0;
  const extraCharge = extraChargeRaw ? parseImportNumber(extraChargeRaw) : 0;
  const capacity = capacityRaw ? parseInteger(capacityRaw) : null;
  const isActive = activeRaw ? parseBoolean(activeRaw) : true;
  const sortOrder = sortRaw ? parseInteger(sortRaw) : 0;
  const bookingMode = bookingModeRaw
    ? parseEnum(bookingModeRaw, ["public", "private"] as const)
    : kind === "open-studio"
      ? "public"
      : null;

  if (priceRaw && price === null) parseErrors.push("price");
  if (extraChargeRaw && extraCharge === null) parseErrors.push("extraCharge");
  if (capacityRaw && capacity === null) parseErrors.push("capacity");
  if (activeRaw && isActive === null) parseErrors.push("isActive");
  if (sortRaw && sortOrder === null) parseErrors.push("sortOrder");
  if (bookingModeRaw && bookingMode === null) parseErrors.push("bookingMode");

  const externalId = valueAt(raw, mapping, "externalId");
  return {
    name: valueAt(raw, mapping, "name"),
    kind,
    type: typeForKind(kind),
    description: valueAt(raw, mapping, "description"),
    sku: valueAt(raw, mapping, "sku"),
    price,
    extraCharge,
    currency,
    capacity,
    bookingMode,
    isActive,
    sortOrder,
    ...(externalId ? { externalId } : {}),
    providedFields,
    kindInput,
    parseErrors,
  };
};

const error = (
  code: string,
  message: string,
  field?: ImportIssue["field"],
): ImportIssue => ({ code, message, field, severity: "error" });

export const validateProductImportRow = (
  value: NormalizedProductImportRow,
  tenantCurrency = "CZK",
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  if (!value.name)
    issues.push(
      error(
        "PRODUCT_NAME_REQUIRED",
        "Product or service name is required.",
        "name",
      ),
    );
  if (value.name.length > 160)
    issues.push(
      error(
        "PRODUCT_NAME_TOO_LONG",
        "Name can contain at most 160 characters.",
        "name",
      ),
    );
  const normalizedInput = normalizeToken(value.kindInput);
  if (!value.kind) {
    if (["service", "sluzba"].includes(normalizedInput)) {
      issues.push(
        error(
          "PRODUCT_KIND_AMBIGUOUS",
          "Choose whether this service is Open Studio or Class before importing.",
          "kind",
        ),
      );
    } else if (
      ["membership", "credit-pack", "credits", "clenstvi", "kredity"].includes(
        normalizedInput,
      )
    ) {
      issues.push(
        error(
          "PRODUCT_DEDICATED_IMPORT_REQUIRED",
          "Memberships and credits use their dedicated import.",
          "kind",
        ),
      );
    } else {
      issues.push(
        error(
          "PRODUCT_KIND_INVALID",
          "Product kind must be Open Studio, Class, or Private Studio.",
          "kind",
        ),
      );
    }
  }
  if (value.kind === "voucher") {
    issues.push(
      error(
        "PRODUCT_DEDICATED_IMPORT_REQUIRED",
        "Voucher products use the dedicated voucher import.",
        "kind",
      ),
    );
  }
  if (value.description.length > 5_000)
    issues.push(
      error(
        "PRODUCT_DESCRIPTION_TOO_LONG",
        "Description can contain at most 5,000 characters.",
        "description",
      ),
    );
  if (value.sku.length > 120)
    issues.push(
      error(
        "PRODUCT_SKU_TOO_LONG",
        "SKU can contain at most 120 characters.",
        "sku",
      ),
    );
  if (value.externalId && value.externalId.length > 120)
    issues.push(
      error(
        "PRODUCT_EXTERNAL_ID_TOO_LONG",
        "External ID can contain at most 120 characters.",
        "externalId",
      ),
    );
  if (
    value.parseErrors.includes("price") ||
    value.price === null ||
    value.price < 0
  )
    issues.push(
      error(
        "PRODUCT_PRICE_INVALID",
        "Price must be a non-negative number.",
        "price",
      ),
    );
  if (
    value.parseErrors.includes("extraCharge") ||
    value.extraCharge === null ||
    value.extraCharge < 0
  )
    issues.push(
      error(
        "PRODUCT_EXTRA_CHARGE_INVALID",
        "Extra charge must be a non-negative number.",
        "extraCharge",
      ),
    );
  if (
    !isStudioCommerceCurrency(value.currency) ||
    value.currency !== tenantCurrency.toUpperCase()
  )
    issues.push(
      error(
        "PRODUCT_CURRENCY_INVALID",
        `Currency must match the workspace currency (${tenantCurrency.toUpperCase()}).`,
        "currency",
      ),
    );
  const exponent = isStudioCommerceCurrency(value.currency)
    ? getCurrencyExponent(value.currency)
    : 2;
  for (const [field, amount] of [
    ["price", value.price],
    ["extraCharge", value.extraCharge],
  ] as const) {
    if (
      amount !== null &&
      Math.abs(amount * 10 ** exponent - Math.round(amount * 10 ** exponent)) >
        1e-7
    ) {
      issues.push(
        error(
          "PRODUCT_PRICE_PRECISION_INVALID",
          `${value.currency} amount has too many decimal places.`,
          field,
        ),
      );
    }
  }
  if (
    value.parseErrors.includes("capacity") ||
    (value.capacity !== null &&
      (!Number.isSafeInteger(value.capacity) ||
        value.capacity < 1 ||
        value.capacity > 500))
  )
    issues.push(
      error(
        "PRODUCT_CAPACITY_INVALID",
        "Capacity must be a whole number from 1 to 500.",
        "capacity",
      ),
    );
  if (
    value.isActive !== false &&
    ["open-studio", "class"].includes(value.kind) &&
    value.capacity === null
  )
    issues.push(
      error(
        "PRODUCT_CAPACITY_REQUIRED",
        "Active Open Studio and Class products require a capacity.",
        "capacity",
      ),
    );
  if (value.parseErrors.includes("bookingMode"))
    issues.push(
      error(
        "PRODUCT_BOOKING_MODE_INVALID",
        "Booking mode must be public or private.",
        "bookingMode",
      ),
    );
  if (value.kind === "open-studio" && !value.bookingMode)
    issues.push(
      error(
        "PRODUCT_BOOKING_MODE_REQUIRED",
        "Open Studio requires a booking mode.",
        "bookingMode",
      ),
    );
  if (value.kind && value.kind !== "open-studio" && value.bookingMode)
    issues.push(
      error(
        "PRODUCT_BOOKING_MODE_UNEXPECTED",
        "Booking mode is only available for Open Studio.",
        "bookingMode",
      ),
    );
  if (
    value.kind === "private-studio" &&
    (value.price !== 0 || value.extraCharge !== 0 || value.capacity !== null)
  )
    issues.push(
      error(
        "PRODUCT_PRIVATE_STUDIO_INVALID",
        "Private Studio must have zero price and no customer capacity.",
        "kind",
      ),
    );
  if (value.parseErrors.includes("isActive") || value.isActive === null)
    issues.push(
      error(
        "PRODUCT_ACTIVE_INVALID",
        "Active must be true/false, yes/no, or ano/ne.",
        "isActive",
      ),
    );
  if (value.parseErrors.includes("sortOrder") || value.sortOrder === null)
    issues.push(
      error(
        "PRODUCT_SORT_ORDER_INVALID",
        "Sort order must be a whole number.",
        "sortOrder",
      ),
    );
  return issues;
};

export const productFileIdentityKeys = (value: NormalizedProductImportRow) => [
  ...(value.externalId
    ? [{ kind: "externalId" as const, value: value.externalId }]
    : []),
  ...(value.sku
    ? [{ kind: "sku" as const, value: value.sku.toLocaleLowerCase() }]
    : []),
  ...(value.name
    ? [{ kind: "name" as const, value: value.name.toLocaleLowerCase() }]
    : []),
];
