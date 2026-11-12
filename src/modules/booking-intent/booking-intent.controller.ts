import type { Request, Response } from "express";

import {
  getAuthenticatedUserId,
} from "@/modules/auth/auth.utils.js";
import type {
  PublishedTenantRequest,
} from "@/modules/setup-center/setup-publication.middleware.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  checkoutBookingIntent,
  createSignedBookingIntent,
  restoreBookingIntent,
  quoteBookingIntentVoucher,
} from "./booking-intent.service.js";
import {
  bookingIntentTokenParamsSchema,
  checkoutBookingIntentSchema,
  createBookingIntentSchema,
  idempotencyKeySchema,
  quoteBookingIntentVoucherSchema,
} from "./booking-intent.validators.js";

export const createBookingIntent = asyncHandler(
  async (
    req: PublishedTenantRequest,
    res: Response,
  ): Promise<void> => {
    if (!req.tenant) {
      notFound({
        message: "Workspace not found.",
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      });
    }

    const input = createBookingIntentSchema.parse(req.body);
    const result = await createSignedBookingIntent({
      tenant: req.tenant,
      input,
    });

    res.set("Cache-Control", "no-store, max-age=0");
    res.status(201).json(result);
  },
);

export const getBookingIntent = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { token } = bookingIntentTokenParamsSchema.parse(req.params);
    const result = await restoreBookingIntent({
      token,
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const checkoutBookingIntentController = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { token } = bookingIntentTokenParamsSchema.parse(req.params);
    const input = checkoutBookingIntentSchema.parse(req.body);
    const idempotencyKey = idempotencyKeySchema.parse(
      req.get("Idempotency-Key"),
    );
    const result = await checkoutBookingIntent({
      token,
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      idempotencyKey,
      input,
      requestOrigin: req.get("origin"),
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const quoteBookingIntentVoucherController = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { token } = bookingIntentTokenParamsSchema.parse(req.params);
  const { voucherCode } = quoteBookingIntentVoucherSchema.parse(req.body);
  const result = await quoteBookingIntentVoucher({ token, voucherCode, tenantId: requireTenantId(req), userId: getAuthenticatedUserId(req) });
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.status(200).json(result);
});
