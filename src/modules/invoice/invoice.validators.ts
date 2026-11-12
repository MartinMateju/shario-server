import { z } from "zod";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import {
  DEFAULT_INVOICE_PAGE_SIZE,
  INVOICE_DOCUMENT_STATUS,
  INVOICE_DOCUMENT_TYPE,
  INVOICE_LOCALE,
  MANUAL_INVOICE_PAYMENT_METHODS,
  INVOICE_PAYMENT_STATUS,
  MAX_INVOICE_PAGE_SIZE,
} from "./invoice.constants.js";

const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, "Enter a valid identifier.");

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Enter a valid idempotency key.");

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidCalendarDate = (value: string): boolean => {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

/**
 * A date from an HTML date input is a calendar date, not a UTC instant.
 * Keep YYYY-MM-DD values intact so the service can interpret them in the
 * tenant's IANA timezone. Existing ISO datetime clients remain compatible
 * and are normalized to Date instances.
 */
const invoiceDateInputSchema = z
  .union([
    z.date(),
    z
      .string()
      .trim()
      .min(1, "Enter a valid date.")
      .refine(
        (value) =>
          CALENDAR_DATE_PATTERN.test(value)
            ? isValidCalendarDate(value)
            : Number.isFinite(new Date(value).getTime()),
        "Enter a valid date.",
      ),
  ])
  .transform((value) => {
    if (value instanceof Date || CALENDAR_DATE_PATTERN.test(value)) {
      return value;
    }

    return new Date(value);
  });

const RFC3339_WITH_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/**
 * Date.parse() normalizes impossible calendar values (for example,
 * 2026-02-31) instead of rejecting them. Validate every RFC 3339 component
 * before converting an audited payment timestamp to a Date.
 */
const isValidRfc3339DateTime = (value: string): boolean => {
  const match = RFC3339_WITH_OFFSET_PATTERN.exec(value);

  if (!match) return false;

  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    offsetSign,
    offsetHourValue,
    offsetMinuteValue,
  ] = match;

  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);

  if (
    !isValidCalendarDate(`${yearValue}-${monthValue}-${dayValue}`) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (offsetSign) {
    const offsetHour = Number(offsetHourValue);
    const offsetMinute = Number(offsetMinuteValue);

    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    Number.isFinite(new Date(value).getTime())
  );
};

const paymentDateInputSchema = z
  .union([
    z.date(),
    z
      .string()
      .trim()
      .min(1, "Enter a valid payment date.")
      .refine(
        (value) =>
          (CALENDAR_DATE_PATTERN.test(value)
            ? isValidCalendarDate(value)
            : isValidRfc3339DateTime(value)),
        "Use YYYY-MM-DD or an RFC 3339 datetime with Z/UTC offset.",
      ),
  ])
  .transform((value) => {
    if (value instanceof Date || CALENDAR_DATE_PATTERN.test(value)) {
      return value;
    }

    return new Date(value);
  })
  .refine(
    (value) =>
      typeof value === "string" ||
      value.getTime() <= Date.now() + 5 * 60 * 1000,
    "Payment date cannot be in the future.",
  );

const isDueDateBeforeIssueDate = (
  issueDate: Date | string | null | undefined,
  dueDate: Date | string | null | undefined,
): boolean => {
  if (!issueDate || !dueDate) return false;

  if (issueDate instanceof Date && dueDate instanceof Date) {
    return dueDate.getTime() < issueDate.getTime();
  }

  if (typeof issueDate === "string" && typeof dueDate === "string") {
    return dueDate < issueDate;
  }

  // Mixed calendar-date/datetime comparisons require the tenant timezone and
  // are therefore validated by the service after conversion.
  return false;
};

const addressSchema = z
  .object({
    line1: z.string().trim().max(200).default(""),
    line2: z.string().trim().max(200).default(""),
    city: z.string().trim().max(120).default(""),
    postalCode: z.string().trim().max(32).default(""),
    country: z.string().trim().max(120).default(""),
    countryCode: z.string().trim().toUpperCase().max(2).default(""),
  })
  .strict();

export const invoicePartySchema = z
  .object({
    legalName: z.string().trim().max(200).default(""),
    tradingName: z.string().trim().max(200).default(""),
    firstname: z.string().trim().max(80).default(""),
    lastname: z.string().trim().max(80).default(""),
    email: z.union([z.literal(""), z.string().trim().email().max(254)]).default(""),
    phone: z.string().trim().max(40).default(""),
    registrationNumber: z.string().trim().max(80).default(""),
    taxId: z.string().trim().max(80).default(""),
    vatId: z.string().trim().max(80).default(""),
    address: addressSchema.default({
      line1: "",
      line2: "",
      city: "",
      postalCode: "",
      country: "",
      countryCode: "",
    }),
  })
  .strict();

export const updateInvoiceSettingsSchema = z
  .object({
    legalName: z.string().trim().max(200).optional(),
    tradingName: z.string().trim().max(200).optional(),
    registrationNumber: z.string().trim().max(80).optional(),
    taxId: z.string().trim().max(80).optional(),
    vatId: z.string().trim().max(80).optional(),
    address: addressSchema.partial().optional(),
    contact: z
      .object({
        email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional(),
        phone: z.string().trim().max(40).optional(),
      })
      .strict()
      .optional(),
    bank: z
      .object({
        accountName: z.string().trim().max(200).optional(),
        accountNumber: z.string().trim().max(100).optional(),
        iban: z.string().trim().toUpperCase().max(64).optional(),
        bic: z.string().trim().toUpperCase().max(32).optional(),
      })
      .strict()
      .optional(),
    locale: z.enum(Object.values(INVOICE_LOCALE) as [string, ...string[]]).optional(),
    defaultDueDays: z.coerce.number().int().min(0).max(365).optional(),
    pricesIncludeTax: z.boolean().optional(),
    defaultTaxRateBps: z.coerce.number().int().min(0).max(10000).optional(),
    invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/).optional(),
    creditNotePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/).optional(),
    autoCreatePaidOrderInvoices: z.boolean().optional(),
    autoFinalizePaidOrderInvoices: z.boolean().optional(),
    autoSendPaidOrderInvoices: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one invoicing setting is required.",
  });

const manualInvoiceLineSchema = z
  .object({
    productId: objectIdSchema.optional(),
    description: z.string().trim().min(1).max(500),
    sku: z.string().trim().max(120).default(""),
    quantity: z.coerce.number().int().min(1).max(100000),
    unitGrossMinor: z.coerce.number().int().min(0),
    taxRateBps: z.coerce.number().int().min(0).max(10000).optional(),
    locationIds: z.array(objectIdSchema).max(100).default([]),
  })
  .strict();

export const createManualInvoiceSchema = z
  .object({
    currency: z.enum(STUDIO_COMMERCE_CURRENCIES),
    customerUserId: objectIdSchema.optional(),
    customer: invoicePartySchema,
    lines: z.array(manualInvoiceLineSchema).min(1).max(200),
    locationIds: z.array(objectIdSchema).max(100).default([]),
    issueDate: invoiceDateInputSchema.optional(),
    dueDate: invoiceDateInputSchema.optional(),
    taxableSupplyDate: invoiceDateInputSchema.optional(),
    locale: z.enum(Object.values(INVOICE_LOCALE) as [string, ...string[]]).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      isDueDateBeforeIssueDate(value.issueDate, value.dueDate)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Due date cannot be before the issue date.",
      });
    }
  });

export const updateDraftInvoiceSchema = z
  .object({
    customerUserId: objectIdSchema.nullable().optional(),
    customer: invoicePartySchema.optional(),
    lines: z.array(manualInvoiceLineSchema).min(1).max(200).optional(),
    locationIds: z.array(objectIdSchema).max(100).optional(),
    issueDate: invoiceDateInputSchema.nullable().optional(),
    dueDate: invoiceDateInputSchema.nullable().optional(),
    taxableSupplyDate: invoiceDateInputSchema.nullable().optional(),
    locale: z.enum(Object.values(INVOICE_LOCALE) as [string, ...string[]]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one invoice field is required.",
  });

export const invoiceListSchema = z
  .object({
    search: z.string().trim().max(200).default(""),
    documentType: z
      .enum(Object.values(INVOICE_DOCUMENT_TYPE) as [string, ...string[]])
      .optional(),
    documentStatus: z
      .enum(Object.values(INVOICE_DOCUMENT_STATUS) as [string, ...string[]])
      .optional(),
    paymentStatus: z
      .enum(Object.values(INVOICE_PAYMENT_STATUS) as [string, ...string[]])
      .optional(),
    locationId: objectIdSchema.optional(),
    customerUserId: objectIdSchema.optional(),
    orderId: objectIdSchema.optional(),
    dateFrom: invoiceDateInputSchema.optional(),
    dateTo: invoiceDateInputSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_INVOICE_PAGE_SIZE)
      .default(DEFAULT_INVOICE_PAGE_SIZE),
  })
  .strict();

export const creditNoteSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    lines: z
      .array(
        z
          .object({
            lineItemId: objectIdSchema,
            grossAmountMinor: z.coerce.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .optional(),
    send: z.boolean().default(false),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = (value.lines ?? []).map((line) => line.lineItemId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["lines"],
        message: "Each invoice line may only be credited once per request.",
      });
    }
  });

export const sendInvoiceSchema = z
  .object({
    recipient: z.string().trim().email().max(254).optional(),
  })
  .strict();

export const recordInvoicePaymentSchema = z
  .object({
    amountMinor: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    method: z.enum(MANUAL_INVOICE_PAYMENT_METHODS),
    reference: z.string().trim().max(200).default(""),
    // Preserve bare calendar dates so the service can interpret them in the
    // tenant's timezone. ISO datetimes remain exact instants.
    paidAt: paymentDateInputSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const reverseInvoicePaymentSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export type UpdateInvoiceSettingsInput = z.infer<typeof updateInvoiceSettingsSchema>;
export type CreateManualInvoiceInput = z.infer<typeof createManualInvoiceSchema>;
export type UpdateDraftInvoiceInput = z.infer<typeof updateDraftInvoiceSchema>;
export type InvoiceListInput = z.infer<typeof invoiceListSchema>;
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;
export type RecordInvoicePaymentInput = z.infer<
  typeof recordInvoicePaymentSchema
>;
export type ReverseInvoicePaymentInput = z.infer<
  typeof reverseInvoicePaymentSchema
>;
