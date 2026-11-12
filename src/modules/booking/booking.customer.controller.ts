import type { Request, Response } from "express";
import { z } from "zod";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  assertCustomerAccount,
  cancelMyBooking,
  getMyBookingRescheduleAvailability,
  getMyBooking,
  listMyBookings,
  rescheduleMyBooking,
} from "./booking.customer.service.js";
import {
  listCustomerBookingAvailability,
} from "./booking.public.service.js";
import { objectIdSchema } from "./booking.validators.js";
import { getBookingExtensionOptions, cancelPendingBookingExtension } from "./booking.extension.service.js";
import { checkoutService } from "@/modules/checkout/services/checkout.service.js";
import User from "@/modules/user/user.model.js";
import { resolveTenantCommerceOrigin, normalizeCommerceLocale } from "@/modules/checkout/checkout.urls.js";
import { badRequest } from "@/shared/http/httpErrors.js";

const listQuerySchema = z
  .object({
    scope: z.enum(["upcoming", "history", "all"]).default("upcoming"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    locationId: objectIdSchema("location id").optional(),
  })
  .strict();

const availabilityQuerySchema = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
    locationId: objectIdSchema("location id").optional(),
  })
  .strict();

const bookingParamsSchema = z
  .object({
    bookingId: objectIdSchema("booking id"),
  })
  .strict();

const rescheduleBodySchema = z
  .object({
    start: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
  })
  .strict();

const rescheduleAvailabilityQuerySchema = z
  .object({
    date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const extensionBodySchema = z
  .object({
    minutes: z.union([
      z.literal(30),
      z.literal(60),
      z.literal(90),
      z.literal(120),
    ]),
    expectedEnd: z.iso.datetime({ offset: true }),
    expectedAmountMinor: z.number().int().nonnegative(),
    quoteVersion: z.string().regex(/^[a-f0-9]{64}$/),
    paymentMethod: z.enum(["credits", "card"]),
    locale: z.string().max(10).default("en"),
  })
  .strict();

export const getCustomerBookingExtensionOptions = asyncHandler(
  async (req: Request, res: Response) => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    await assertCustomerAccount({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      allowWorkspaceIdentity: true,
    });
    const result = await getBookingExtensionOptions({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
    });
    res.set("Cache-Control", "private, no-store").json(result);
  },
);

export const cancelCustomerBookingExtensionPayment = asyncHandler(
  async (req: Request, res: Response) => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const { orderId } = z
      .object({ orderId: objectIdSchema("order id") })
      .strict()
      .parse(req.body);
    const result = await cancelPendingBookingExtension({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
      orderId,
    });
    res.set("Cache-Control", "private, no-store").json(result);
  },
);

export const extendCustomerBooking = asyncHandler(
  async (req: Request, res: Response) => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const input = extensionBodySchema.parse(req.body);
    await assertCustomerAccount({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      allowWorkspaceIdentity: true,
    });
    const key = String(req.get("Idempotency-Key") || "");
    if (!key || key.length > 200)
      badRequest({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "An idempotency key is required for an extension payment.",
      });
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const tenant = await getTenantOrThrow(tenantId);
    const user = await User.findOne({ _id: userId, tenant: tenantId });
    if (!user) badRequest("Customer not found.");
    const originUrl = resolveTenantCommerceOrigin({
      tenant,
      requestedOrigin: req.get("origin"),
    });
    const cartItems = [
      {
        bookingExtension: {
          bookingId,
          minutes: input.minutes,
          expectedEnd: input.expectedEnd,
          expectedAmountMinor: input.expectedAmountMinor,
          quoteVersion: input.quoteVersion,
        },
        language: input.locale,
      },
    ];
    const args = {
      tenantId,
      user,
      cartItems,
      originUrl,
      locale: normalizeCommerceLocale(input.locale),
      idempotencyKey: key,
      membershipDiscountEligible: false,
    };
    const result =
      input.paymentMethod === "card"
        ? await checkoutService.createStripeCheckout({
            ...args,
            currency: tenant.settings.currency,
            successPath: "portal/success",
            cancelPath: "portal/bookings",
          })
        : await checkoutService.checkoutWithCredits(args);
    res
      .set("Cache-Control", "private, no-store")
      .json(
        input.paymentMethod === "card" && result.status !== "confirmed"
          ? { ...result, status: "pending" }
          : {
              ...result,
              success: true,
              status: "confirmed",
              booking: await getMyBooking({ tenantId, userId, bookingId }),
            },
      );
  },
);

export const getCustomerBookingAvailability = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const query = availabilityQuerySchema.parse(req.query);
    const tenant = await getTenantOrThrow(requireTenantId(req));
    const result = await listCustomerBookingAvailability({
      tenant,
      ...query,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const listCustomerBookings = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const query = listQuerySchema.parse(req.query);
    const result = await listMyBookings({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      ...query,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const getCustomerBooking = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const booking = await getMyBooking({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json({ booking });
  },
);

export const cancelCustomerBooking = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const result = await cancelMyBooking({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const getCustomerBookingRescheduleAvailability = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const { date } = rescheduleAvailabilityQuerySchema.parse(req.query);
    const result = await getMyBookingRescheduleAvailability({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
      date,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const rescheduleCustomerBooking = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { bookingId } = bookingParamsSchema.parse(req.params);
    const { start } = rescheduleBodySchema.parse(req.body);
    const booking = await rescheduleMyBooking({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      bookingId,
      start,
    });

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json({ booking });
  },
);
