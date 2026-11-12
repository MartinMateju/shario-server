import { badRequest } from "@/shared/http/httpErrors.js";

import {
  BOOKING_IMPORT_FIELDS,
  CREDIT_IMPORT_FIELDS,
  CUSTOMER_IMPORT_FIELDS,
  MEMBERSHIP_IMPORT_FIELDS,
  MEMBERSHIP_PLAN_IMPORT_FIELDS,
  PRODUCT_IMPORT_FIELDS,
  VOUCHER_IMPORT_FIELDS,
  VOUCHER_PRODUCT_IMPORT_FIELDS,
  type BookingImportField,
  type CreditImportField,
  type CustomerImportField,
  type MembershipImportField,
  type MembershipPlanImportField,
  type ProductImportField,
  type VoucherImportField,
  type VoucherProductImportField,
} from "../data-import.constants.js";
import type {
  BookingImportColumnMapping,
  CreditImportColumnMapping,
  ImportColumnMapping,
  MembershipImportColumnMapping,
  MembershipPlanImportColumnMapping,
  ProductImportColumnMapping,
  VoucherImportColumnMapping,
  VoucherProductImportColumnMapping,
} from "../data-import.types.js";

export const normalizeImportHeader = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+\(\d+\)$/, "")
    .replace(/[^a-z0-9]+/g, "");

const aliases: Record<CustomerImportField, readonly string[]> = {
  fullName: [
    "name",
    "full name",
    "customer name",
    "client name",
    "jmeno zakaznika",
    "cele jmeno",
  ],
  firstName: [
    "first name",
    "firstname",
    "given name",
    "jmeno",
    "krestni jmeno",
  ],
  lastName: ["last name", "lastname", "surname", "family name", "prijmeni"],
  email: ["email", "e-mail", "email address", "mail", "e-mailova adresa"],
  phone: [
    "phone",
    "phone number",
    "mobile",
    "mobile number",
    "telephone",
    "telefon",
    "mobil",
  ],
  memberNumber: [
    "member number",
    "member id",
    "pottery id",
    "pottery number",
    "customer number",
    "member number (pottery id)",
    "clenske cislo",
    "id keramiky",
  ],
  externalId: [
    "external id",
    "customer external id",
    "customer id",
    "client id",
    "contact id",
    "legacy id",
    "id zakaznika",
  ],
  passwordHash: ["legacy password hash (bcrypt)"],
};

const normalizedAliases = Object.fromEntries(
  Object.entries(aliases).map(([field, values]) => [
    field,
    new Set(values.map(normalizeImportHeader)),
  ]),
) as Record<CustomerImportField, Set<string>>;

export const suggestCustomerColumnMapping = (
  headers: string[],
): ImportColumnMapping => {
  const mapping: ImportColumnMapping = {};
  const claimed = new Set<string>();
  for (const field of CUSTOMER_IMPORT_FIELDS) {
    const match = headers.find(
      (header) =>
        !claimed.has(header) &&
        normalizedAliases[field].has(normalizeImportHeader(header)),
    );
    if (match) {
      mapping[field] = match;
      claimed.add(match);
    }
  }
  return mapping;
};

export const assertValidCustomerColumnMapping = (
  headers: string[],
  value: unknown,
): ImportColumnMapping => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest({
      message: "Column mapping is required.",
      code: "IMPORT_MAPPING_INVALID",
    });
  }
  const mapping: ImportColumnMapping = {};
  const sources = new Set<string>();
  for (const [field, source] of Object.entries(value)) {
    if (!CUSTOMER_IMPORT_FIELDS.includes(field as CustomerImportField)) {
      badRequest({
        message: "Unknown customer field: " + field + ".",
        code: "IMPORT_MAPPING_FIELD_INVALID",
      });
    }
    if (source === null || source === undefined || source === "") continue;
    if (typeof source !== "string" || !headers.includes(source)) {
      badRequest({
        message: "Mapped source column is not present: " + String(source) + ".",
        code: "IMPORT_MAPPING_SOURCE_INVALID",
      });
    }
    if (sources.has(source)) {
      badRequest({
        message: "A source column can only be mapped once.",
        code: "IMPORT_MAPPING_SOURCE_DUPLICATE",
      });
    }
    mapping[field as CustomerImportField] = source;
    sources.add(source);
  }
  if (!mapping.fullName && !mapping.firstName && !mapping.lastName) {
    badRequest({
      message: "Map Full name, First name, or Last name.",
      code: "IMPORT_MAPPING_NAME_REQUIRED",
    });
  }
  return mapping;
};

const productAliases: Record<ProductImportField, readonly string[]> = {
  name: [
    "name",
    "product name",
    "service name",
    "offer name",
    "nazev",
    "nazev sluzby",
  ],
  kind: [
    "kind",
    "type",
    "category",
    "service type",
    "product type",
    "typ",
    "kategorie",
    "typ sluzby",
  ],
  description: ["description", "details", "popis"],
  sku: ["sku", "product code", "service code", "kod produktu", "kod sluzby"],
  price: ["price", "unit price", "amount", "cena"],
  extraCharge: ["extra charge", "surcharge", "doplatek", "priplatek"],
  currency: ["currency", "mena"],
  capacity: [
    "capacity",
    "max participants",
    "maximum participants",
    "places",
    "kapacita",
    "maximalni pocet ucastniku",
  ],
  bookingMode: ["booking mode", "reservation mode", "rezim rezervace"],
  isActive: ["active", "is active", "enabled", "aktivni", "povoleno"],
  sortOrder: ["sort order", "order", "position", "poradi"],
  externalId: [
    "external id",
    "product id",
    "service id",
    "legacy id",
    "externi id",
    "id sluzby",
  ],
};

const bookingAliases: Record<BookingImportField, readonly string[]> = {
  externalId: [
    "external id",
    "booking id",
    "appointment id",
    "reservation id",
    "legacy id",
    "id rezervace",
  ],
  customerExternalId: [
    "customer external id",
    "customer id",
    "client id",
    "contact id",
    "id zakaznika",
  ],
  customerEmail: [
    "customer email",
    "client email",
    "email",
    "mail",
    "email zakaznika",
  ],
  customerPhone: [
    "customer phone",
    "client phone",
    "phone",
    "mobile",
    "telefon zakaznika",
  ],
  productExternalId: [
    "product external id",
    "service external id",
    "product id",
    "service id",
    "id sluzby",
  ],
  productSku: [
    "product sku",
    "service sku",
    "sku",
    "product code",
    "service code",
    "kod sluzby",
  ],
  productName: [
    "product name",
    "service name",
    "offer",
    "service",
    "product",
    "nazev sluzby",
  ],
  locationCode: ["location code", "studio code", "branch code", "kod pobocky"],
  locationSlug: ["location slug", "studio slug", "branch slug"],
  locationName: [
    "location",
    "location name",
    "studio",
    "branch",
    "pobocka",
    "studio name",
  ],
  start: ["start", "starts at", "start datetime", "zacatek", "datum a cas od"],
  end: ["end", "ends at", "end datetime", "konec", "datum a cas do"],
  date: [
    "date",
    "start date",
    "session date",
    "booking date",
    "appointment date",
    "datum",
    "datum rezervace",
  ],
  startTime: ["start time", "time from", "from", "cas od", "zacatek cas"],
  endTime: ["end time", "time to", "to", "cas do", "konec cas"],
  numberOfGuests: [
    "guests",
    "guest count",
    "participants",
    "quantity",
    "pocet hostu",
    "pocet osob",
  ],
  status: ["status", "booking status", "stav", "stav rezervace"],
  language: ["language", "locale", "jazyk"],
  plannedActivity: [
    "activity",
    "planned activity",
    "aktivita",
    "planovana aktivita",
  ],
  lecturer: ["lecturer", "teacher", "instructor", "lektor"],
  description: ["description", "details", "popis"],
  note: ["note", "internal note", "notes", "poznamka"],
};

const normalizedFieldAliases = <Field extends string>(
  values: Record<Field, readonly string[]>,
): Record<Field, Set<string>> =>
  Object.fromEntries(
    Object.entries(values).map(([field, fieldAliases]) => [
      field,
      new Set((fieldAliases as string[]).map(normalizeImportHeader)),
    ]),
  ) as Record<Field, Set<string>>;

const suggestMapping = <Field extends string>(
  headers: string[],
  fields: readonly Field[],
  fieldAliases: Record<Field, Set<string>>,
): Partial<Record<Field, string>> => {
  const mapping: Partial<Record<Field, string>> = {};
  const claimed = new Set<string>();
  for (const field of fields) {
    const match = headers.find(
      (header) =>
        !claimed.has(header) &&
        fieldAliases[field].has(normalizeImportHeader(header)),
    );
    if (match) {
      mapping[field] = match;
      claimed.add(match);
    }
  }
  return mapping;
};

const assertMapping = <Field extends string>(
  headers: string[],
  value: unknown,
  fields: readonly Field[],
  entityLabel: string,
): Partial<Record<Field, string>> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest({
      message: "Column mapping is required.",
      code: "IMPORT_MAPPING_INVALID",
    });
  }
  const mapping: Partial<Record<Field, string>> = {};
  const sources = new Set<string>();
  for (const [field, source] of Object.entries(value)) {
    if (!fields.includes(field as Field)) {
      badRequest({
        message: `Unknown ${entityLabel} field: ${field}.`,
        code: "IMPORT_MAPPING_FIELD_INVALID",
      });
    }
    if (source === null || source === undefined || source === "") continue;
    if (typeof source !== "string" || !headers.includes(source)) {
      badRequest({
        message: "Mapped source column is not present: " + String(source) + ".",
        code: "IMPORT_MAPPING_SOURCE_INVALID",
      });
    }
    if (sources.has(source)) {
      badRequest({
        message: "A source column can only be mapped once.",
        code: "IMPORT_MAPPING_SOURCE_DUPLICATE",
      });
    }
    mapping[field as Field] = source;
    sources.add(source);
  }
  return mapping;
};

const normalizedProductAliases = normalizedFieldAliases(productAliases);
const normalizedBookingAliases = normalizedFieldAliases(bookingAliases);

const membershipPlanAliases: Record<
  MembershipPlanImportField,
  readonly string[]
> = {
  externalId: ["external id", "plan id", "legacy id"],
  name: ["name", "plan name", "membership plan"],
  description: ["description", "details", "popis"],
  terms: ["terms", "conditions", "podminky"],
  price: ["price", "amount", "cena"],
  currency: ["currency", "mena"],
  billingType: ["billing type", "type", "payment type"],
  billingInterval: ["billing interval", "interval", "frequency"],
  intervalCount: ["interval count", "every", "frequency count"],
  durationDays: ["duration days", "duration", "days"],
  locationScope: ["location scope", "scope"],
  locationCodes: ["location codes", "locations", "branch codes"],
  creditAllowance: ["credit allowance", "credits", "included credits"],
  discountPercent: ["discount percent", "discount", "product discount"],
  customPerk: ["custom perk", "perk", "benefit"],
  benefits: ["benefits", "benefits json"],
  sortOrder: ["sort order", "position", "order"],
  status: ["status", "plan status"],
};
const membershipAliases: Record<MembershipImportField, readonly string[]> = {
  externalId: ["external id", "membership id", "legacy id"],
  customerExternalId: ["customer external id", "customer id", "client id"],
  customerEmail: ["customer email", "client email", "email"],
  customerPhone: ["customer phone", "client phone", "phone", "mobile"],
  planExternalId: ["plan external id", "plan id"],
  planName: ["plan name", "membership plan", "plan"],
  planVersion: ["plan version", "version"],
  locationCode: ["location code", "branch code"],
  locationSlug: ["location slug", "branch slug"],
  locationName: ["location", "location name", "branch"],
  status: ["status", "membership status"],
  startedAt: ["started at", "start date", "membership start"],
  periodStart: ["period start", "current period start"],
  periodEnd: ["period end", "current period end", "ends at"],
  cancelledAt: ["cancelled at", "canceled at", "cancellation date"],
  currency: ["currency", "mena"],
  amount: ["amount", "price", "paid amount"],
  allowanceBalances: [
    "allowance balances",
    "remaining allowances",
    "balances json",
  ],
  note: ["note", "notes", "internal note"],
};
const creditAliases: Record<CreditImportField, readonly string[]> = {
  externalId: ["external id", "allocation id", "legacy id"],
  customerExternalId: ["customer external id", "customer id", "client id"],
  customerEmail: ["customer email", "client email", "email"],
  customerPhone: ["customer phone", "client phone", "phone", "mobile"],
  balance: [
    "balance",
    "opening balance",
    "opening credit balance",
    "credits",
    "credit balance",
  ],
  currency: ["currency", "credit currency", "mena"],
  note: ["note", "notes", "reason"],
};
const voucherProductAliases: Record<
  VoucherProductImportField,
  readonly string[]
> = {
  externalId: ["external id", "product id", "voucher product id"],
  name: ["name", "voucher name", "product name"],
  description: ["description", "details", "popis"],
  sku: ["sku", "product code", "voucher code"],
  value: ["value", "price", "amount"],
  currency: ["currency", "mena"],
  isActive: ["active", "is active", "enabled"],
  sortOrder: ["sort order", "position", "order"],
};
const voucherAliases: Record<VoucherImportField, readonly string[]> = {
  externalId: ["external id", "voucher id", "legacy id"],
  promoCode: ["promo code", "voucher code", "code"],
  productExternalId: [
    "product external id",
    "voucher product id",
    "product id",
  ],
  productSku: ["product sku", "voucher sku", "sku"],
  productName: ["product name", "voucher product", "voucher name"],
  status: ["status", "voucher status"],
  value: ["value", "amount", "voucher value"],
  currency: ["currency", "mena"],
  expiresAt: ["expires at", "expiry", "expiration date"],
  redeemedAt: ["redeemed at", "used at", "redemption date"],
  customerExternalId: ["customer external id", "customer id", "client id"],
  customerEmail: ["customer email", "client email", "email"],
  customerPhone: ["customer phone", "client phone", "phone"],
  note: ["note", "notes", "internal note"],
};
const normalizedMembershipPlanAliases = normalizedFieldAliases(
  membershipPlanAliases,
);
const normalizedMembershipAliases = normalizedFieldAliases(membershipAliases);
const normalizedCreditAliases = normalizedFieldAliases(creditAliases);
const normalizedVoucherProductAliases = normalizedFieldAliases(
  voucherProductAliases,
);
const normalizedVoucherAliases = normalizedFieldAliases(voucherAliases);

export const suggestProductColumnMapping = (
  headers: string[],
): ProductImportColumnMapping =>
  suggestMapping(headers, PRODUCT_IMPORT_FIELDS, normalizedProductAliases);

export const assertValidProductColumnMapping = (
  headers: string[],
  value: unknown,
): ProductImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    PRODUCT_IMPORT_FIELDS,
    "product",
  );
  if (!mapping.name || !mapping.kind) {
    badRequest({
      message: "Map Product name and Product kind.",
      code: "IMPORT_MAPPING_PRODUCT_REQUIRED",
    });
  }
  return mapping;
};

export const suggestBookingColumnMapping = (
  headers: string[],
): BookingImportColumnMapping =>
  suggestMapping(headers, BOOKING_IMPORT_FIELDS, normalizedBookingAliases);

export const assertValidBookingColumnMapping = (
  headers: string[],
  value: unknown,
): BookingImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    BOOKING_IMPORT_FIELDS,
    "booking",
  );
  if (
    !mapping.productExternalId &&
    !mapping.productSku &&
    !mapping.productName
  ) {
    badRequest({
      message: "Map a product external ID, SKU, or name.",
      code: "IMPORT_MAPPING_BOOKING_PRODUCT_REQUIRED",
    });
  }
  const timestamps = Boolean(mapping.start && mapping.end);
  const localTimes = Boolean(
    mapping.date && mapping.startTime && mapping.endTime,
  );
  if (!timestamps && !localTimes) {
    badRequest({
      message: "Map Start and End, or Date, Start time, and End time.",
      code: "IMPORT_MAPPING_BOOKING_TIME_REQUIRED",
    });
  }
  return mapping;
};

export const suggestMembershipPlanColumnMapping = (
  headers: string[],
): MembershipPlanImportColumnMapping =>
  suggestMapping(
    headers,
    MEMBERSHIP_PLAN_IMPORT_FIELDS,
    normalizedMembershipPlanAliases,
  );
export const suggestMembershipColumnMapping = (
  headers: string[],
): MembershipImportColumnMapping =>
  suggestMapping(
    headers,
    MEMBERSHIP_IMPORT_FIELDS,
    normalizedMembershipAliases,
  );
export const suggestCreditColumnMapping = (
  headers: string[],
): CreditImportColumnMapping =>
  suggestMapping(headers, CREDIT_IMPORT_FIELDS, normalizedCreditAliases);
export const suggestVoucherProductColumnMapping = (
  headers: string[],
): VoucherProductImportColumnMapping =>
  suggestMapping(
    headers,
    VOUCHER_PRODUCT_IMPORT_FIELDS,
    normalizedVoucherProductAliases,
  );
export const suggestVoucherColumnMapping = (
  headers: string[],
): VoucherImportColumnMapping =>
  suggestMapping(headers, VOUCHER_IMPORT_FIELDS, normalizedVoucherAliases);

export const assertValidMembershipPlanColumnMapping = (
  headers: string[],
  value: unknown,
): MembershipPlanImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    MEMBERSHIP_PLAN_IMPORT_FIELDS,
    "membership plan",
  );
  if (!mapping.name || !mapping.price || !mapping.billingType)
    badRequest({
      message: "Map plan Name, Price, and Billing type.",
      code: "IMPORT_MAPPING_MEMBERSHIP_PLAN_REQUIRED",
    });
  return mapping;
};
export const assertValidMembershipColumnMapping = (
  headers: string[],
  value: unknown,
): MembershipImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    MEMBERSHIP_IMPORT_FIELDS,
    "membership",
  );
  if (
    !mapping.customerExternalId &&
    !mapping.customerEmail &&
    !mapping.customerPhone
  )
    badRequest({
      message: "Map a customer external ID, email, or phone.",
      code: "IMPORT_MAPPING_MEMBERSHIP_REFERENCE_REQUIRED",
    });
  if (!mapping.planExternalId && !mapping.planName)
    badRequest({
      message: "Map a plan external ID or name.",
      code: "IMPORT_MAPPING_MEMBERSHIP_REFERENCE_REQUIRED",
    });
  if (!mapping.startedAt || !mapping.periodEnd)
    badRequest({
      message:
        "Map Started at and Period end. Open rows also need Period start.",
      code: "IMPORT_MAPPING_MEMBERSHIP_DATES_REQUIRED",
    });
  return mapping;
};
export const assertValidCreditColumnMapping = (
  headers: string[],
  value: unknown,
): CreditImportColumnMapping => {
  const mapping = assertMapping(headers, value, CREDIT_IMPORT_FIELDS, "credit");
  if (
    (!mapping.customerExternalId &&
      !mapping.customerEmail &&
      !mapping.customerPhone) ||
    !mapping.balance
  )
    badRequest({
      message: "Map a customer reference and opening balance.",
      code: "IMPORT_MAPPING_CREDIT_REQUIRED",
    });
  return mapping;
};
export const assertValidVoucherProductColumnMapping = (
  headers: string[],
  value: unknown,
): VoucherProductImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    VOUCHER_PRODUCT_IMPORT_FIELDS,
    "voucher product",
  );
  if (!mapping.name || !mapping.value)
    badRequest({
      message: "Map voucher product Name and Value.",
      code: "IMPORT_MAPPING_VOUCHER_PRODUCT_REQUIRED",
    });
  return mapping;
};
export const assertValidVoucherColumnMapping = (
  headers: string[],
  value: unknown,
): VoucherImportColumnMapping => {
  const mapping = assertMapping(
    headers,
    value,
    VOUCHER_IMPORT_FIELDS,
    "voucher",
  );
  if (
    !mapping.promoCode ||
    !mapping.value ||
    (!mapping.productExternalId && !mapping.productSku && !mapping.productName)
  )
    badRequest({
      message: "Map Promo code, Value, and a voucher product reference.",
      code: "IMPORT_MAPPING_VOUCHER_REQUIRED",
    });
  return mapping;
};
