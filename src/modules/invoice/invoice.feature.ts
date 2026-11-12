import type { RequestHandler } from "express";

import { notFound } from "@/shared/http/httpErrors.js";

/**
 * Native Shario invoicing is paused for the MVP. Existing records and tenant
 * settings are retained. Stripe payments, receipts and subscription billing
 * deliberately do not use this switch.
 */
export const isNativeInvoicingEnabled = (): boolean =>
  process.env.NATIVE_INVOICES_ENABLED === "true";

export const assertNativeInvoicingEnabled = (): void => {
  if (!isNativeInvoicingEnabled()) {
    notFound({
      message: "Native invoicing is currently unavailable.",
      code: "INVOICE_FEATURE_DISABLED",
    });
  }
};

export const requireNativeInvoicing: RequestHandler = (_req, _res, next) => {
  assertNativeInvoicingEnabled();
  next();
};
