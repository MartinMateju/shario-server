export const INVOICE_DOCUMENT_TYPE = {
  INVOICE: "invoice",
  CREDIT_NOTE: "credit_note",
} as const;

export const INVOICE_DOCUMENT_STATUS = {
  DRAFT: "draft",
  ISSUED: "issued",
  VOID: "void",
} as const;

export const INVOICE_PAYMENT_STATUS = {
  NOT_APPLICABLE: "not_applicable",
  UNPAID: "unpaid",
  PARTIALLY_PAID: "partially_paid",
  PAID: "paid",
  PARTIALLY_REFUNDED: "partially_refunded",
  REFUNDED: "refunded",
} as const;

export const INVOICE_SOURCE_KIND = {
  ORDER: "order",
  COUPON_ORDER: "coupon_order",
  MANUAL: "manual",
} as const;

export const INVOICE_PAYMENT_METHOD = {
  STRIPE: "stripe",
  CREDITS: "credits",
  VOUCHER: "voucher",
  MIXED: "mixed",
  BANK_TRANSFER: "bank_transfer",
  CASH: "cash",
  CARD: "card",
  MANUAL: "manual",
} as const;

export const MANUAL_INVOICE_PAYMENT_METHODS = [
  INVOICE_PAYMENT_METHOD.BANK_TRANSFER,
  INVOICE_PAYMENT_METHOD.CASH,
  INVOICE_PAYMENT_METHOD.CARD,
  INVOICE_PAYMENT_METHOD.MANUAL,
] as const;

export const INVOICE_LOCALE = {
  CS: "cs",
  EN: "en",
} as const;

export const INVOICE_DELIVERY_STATUS = {
  SENT: "sent",
  FAILED: "failed",
} as const;

export const DEFAULT_INVOICE_PREFIX = "INV";
export const DEFAULT_CREDIT_NOTE_PREFIX = "CN";
export const DEFAULT_INVOICE_DUE_DAYS = 14;
export const DEFAULT_INVOICE_PAGE_SIZE = 25;
export const MAX_INVOICE_PAGE_SIZE = 100;
export const INVOICE_RECONCILIATION_BATCH_SIZE = 50;
export const INVOICE_SEND_CLAIM_TTL_MS = 5 * 60 * 1000;

export type InvoiceDocumentType =
  (typeof INVOICE_DOCUMENT_TYPE)[keyof typeof INVOICE_DOCUMENT_TYPE];
export type InvoiceDocumentStatus =
  (typeof INVOICE_DOCUMENT_STATUS)[keyof typeof INVOICE_DOCUMENT_STATUS];
export type InvoicePaymentStatus =
  (typeof INVOICE_PAYMENT_STATUS)[keyof typeof INVOICE_PAYMENT_STATUS];
export type InvoiceSourceKind =
  (typeof INVOICE_SOURCE_KIND)[keyof typeof INVOICE_SOURCE_KIND];
export type InvoicePaymentMethod =
  (typeof INVOICE_PAYMENT_METHOD)[keyof typeof INVOICE_PAYMENT_METHOD];
export type InvoiceLocale =
  (typeof INVOICE_LOCALE)[keyof typeof INVOICE_LOCALE];
export type InvoiceDeliveryStatus =
  (typeof INVOICE_DELIVERY_STATUS)[keyof typeof INVOICE_DELIVERY_STATUS];
