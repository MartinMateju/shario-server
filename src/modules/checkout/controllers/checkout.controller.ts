import { requireExpectedVoucherQuote } from "../checkout.voucher.validation.js";
import { cancelVoucherCheckout } from "../services/checkout.voucher-session.service.js";
import type { Response } from "express";
import mongoose from "mongoose";

import User from "@/modules/user/user.model.js";
import Booking from "@/modules/booking/booking.model.js";
import Order from "@/modules/order/order.model.js";
import { sendEmail } from "@/infrastructure/email/nodemailer.client.js";
import {
  getAuthenticatedUserEmail,
  getAuthenticatedUserId,
} from "@/modules/auth/auth.utils.js";

import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { normalizeCartItems } from "../checkout.utils.js";
import { checkoutRepository } from "@/modules/checkout/checkout.repository.js";
import { checkoutService } from "../services/checkout.service.js";
import { getPublicGuestCourseOrderStatus } from "../services/checkout.public-guest.service.js";
import { legacyPlatformCheckoutWebhookService } from "../services/checkout.legacy-platform-webhook.service.js";
import type { CheckoutRequest } from "../checkout.types.js";
import { createBookingRepository } from "@/modules/booking/booking.repository.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
  resolveTenantCommerceOrigin,
  type CommerceLocale,
} from "../checkout.urls.js";
import { assertSupportedCheckoutInput } from "../checkout.validators.js";
import { badRequest, forbidden } from "@/shared/http/httpErrors.js";
import { getWaitlistOfferOperationKey } from "@/modules/waitlist/waitlist.checkout.service.js";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || "Unknown error");

const respondRedirect = (
  res: Response,
  clientUrl: string,
  locale: CommerceLocale,
  path = "portal/cancel",
) =>
  res.status(200).json({
    url: buildTenantCommerceUrl({ origin: clientUrl, locale, path }),
  });

const handleCheckoutError = (
  res: Response,
  error: unknown,
  clientUrl: string,
  locale: CommerceLocale,
) => {
  console.error("[CHECKOUT_CONTROLLER_ERROR]", error);

  const err = error as {
    redirectPath?: string;
    statusCode?: number;
    message?: string;
    code?: string;
    details?: unknown;
    required?: unknown;
    available?: unknown;
  };

  if (err?.redirectPath) {
    return respondRedirect(res, clientUrl, locale, err.redirectPath);
  }

  if (err?.statusCode && err.statusCode !== 200) {
    return res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
      details: err.details,
      required: err.required,
      available: err.available,
    });
  }

  if (clientUrl) {
    return respondRedirect(res, clientUrl, locale);
  }

  return res.status(500).json({ message: "Checkout failed." });
};

const resolveCheckoutRequestContext = async (
  req: CheckoutRequest,
): Promise<{
  tenantId: string;
  clientUrl: string;
  locale: CommerceLocale;
}> => {
  const tenantId = requireTenantId(req);
  const tenant = await getTenantOrThrow(tenantId);
  const locale = normalizeCommerceLocale(req.body?.locale);

  return {
    tenantId,
    locale,
    clientUrl: resolveTenantCommerceOrigin({
      tenant,
      requestedOrigin: req.get("origin") || req.body?.origin,
    }),
  };
};

const waitlistIdempotencyKey = ({
  explicit,
  operationKey,
}: {
  explicit?: string;
  operationKey?: string;
}): string | undefined => {
  if (explicit) return explicit;
  return operationKey || undefined;
};

export const cancelVoucherPayment = async (
  req: CheckoutRequest,
  res: Response,
) => {
  const result = await cancelVoucherCheckout({
    tenantId: requireTenantId(req),
    userId: getAuthenticatedUserId(req),
    orderId: String(req.params.orderId || ""),
  });
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(result);
};

export const quoteVoucherCheckout = async (
  req: CheckoutRequest,
  res: Response,
) => {
  assertSupportedCheckoutInput(req.body);
  const tenantId = requireTenantId(req);
  const user = await checkoutRepository.findUserByEmail({
    tenantId,
    email: getAuthenticatedUserEmail(req),
  });
  if (!user) return res.status(404).json({ message: "User not found." });
  const quote = await checkoutService.quoteVoucherCheckout({
    tenantId,
    user,
    cartItems: normalizeCartItems(req.body?.cart),
    voucherCode: req.body?.voucherCode,
    currency: req.body?.currency,
  });
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(quote);
};

export const quoteCheckout = async (req: CheckoutRequest, res: Response) => {
  assertSupportedCheckoutInput(req.body);
  const tenantId = requireTenantId(req);
  const user = await checkoutRepository.findUserByEmail({
    tenantId, email: getAuthenticatedUserEmail(req),
  });
  if (!user) return res.status(404).json({ message: "User not found." });
  const result = await checkoutService.quoteCart({
    tenantId, user, cartItems: normalizeCartItems(req.body?.cart), currency: req.body?.currency,
  });
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(result);
};

export const checkoutWithMembership = async (req: CheckoutRequest, res: Response) => {
  assertSupportedCheckoutInput(req.body);
  if (req.body?.voucherCode) badRequest({
    code: "MEMBERSHIP_VOUCHER_COMBINATION_UNSUPPORTED",
    message: "Use membership hours separately from vouchers.",
  });
  const membershipBenefitKey = req.body?.membershipBenefitKey;
  if (typeof membershipBenefitKey !== "string" || !membershipBenefitKey.trim()) badRequest({
    code: "MEMBERSHIP_ENTITLEMENT_INVALID", message: "Select a membership allowance.",
  });
  const { tenantId, clientUrl, locale } = await resolveCheckoutRequestContext(req);
  const user = await checkoutRepository.findUserByEmail({
    tenantId, email: getAuthenticatedUserEmail(req),
  });
  if (!user) return res.status(404).json({ message: "User not found." });
  const result = await checkoutService.checkoutWithCredits({
    tenantId, user, cartItems: normalizeCartItems(req.body?.cart), originUrl: clientUrl,
    locale, idempotencyKey: req.get("Idempotency-Key"),
    paymentSource: "membership_credits", membershipBenefitKey: membershipBenefitKey.trim(),
  });
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(result);
};

export const sendCheckout = async (req: CheckoutRequest, res: Response) => {
  let clientUrl = "";
  let locale = normalizeCommerceLocale(req.body?.locale);

  try {
    assertSupportedCheckoutInput(req.body);

    const cartItems = normalizeCartItems(req.body?.cart);
    const context = await resolveCheckoutRequestContext(req);
    const { tenantId } = context;
    locale = context.locale;
    clientUrl = context.clientUrl;
    const user = await checkoutRepository.findUserByEmail({
      tenantId,
      email: getAuthenticatedUserEmail(req),
    });

    if (!user) return respondRedirect(res, clientUrl, locale);

    const waitlistOfferToken = String(
      req.body?.waitlistOfferToken || "",
    ).trim();
    if (waitlistOfferToken) {
      const tenant = await getTenantOrThrow(tenantId);
      if (!tenant.modules?.courses || !tenant.modules?.payments) {
        forbidden({
          message: "Class checkout is unavailable for this workspace.",
          code: "TENANT_MODULE_REQUIRED",
        });
      }
    }
    const operationKey = waitlistOfferToken
      ? await getWaitlistOfferOperationKey({
          tenantId,
          customerId: String(user._id || user.id),
          email: String(user.email || ""),
          offerToken: waitlistOfferToken,
        })
      : undefined;

    const result = await checkoutService.createStripeCheckout({
      tenantId,
      user,
      cartItems,
      originUrl: clientUrl,
      currency: req.body?.currency,
      creditsToApplyMajor: 0,
      voucherCode: req.body?.voucherCode,
      expectedVoucherQuote: req.body?.voucherCode
        ? requireExpectedVoucherQuote(req.body?.expectedVoucherQuote)
        : undefined,
      locale,
      // The saved waitlist amount remains the base price. An authenticated
      // member can use their personal course benefit when creating the order.
      membershipDiscountEligible: true,
      ...(waitlistOfferToken ? { cancelPath: "waitlists/offer#resume" } : {}),
      idempotencyKey: waitlistIdempotencyKey({
        explicit: req.get("Idempotency-Key"),
        operationKey,
      }),
      waitlistOfferToken,
    });

    return res.status(200).send(
      JSON.stringify({
        url: result.url,
        ...(result.status === "confirmed"
          ? { status: "confirmed", success: true, orderId: result.orderId }
          : {}),
      }),
    );
  } catch (error) {
    return handleCheckoutError(res, error, clientUrl, locale);
  }
};

export const sendWaitlistEntryCheckout = async (
  req: CheckoutRequest,
  res: Response,
) => {
  let clientUrl = "";
  let locale = normalizeCommerceLocale(req.body?.locale);
  try {
    assertSupportedCheckoutInput(req.body);
    const context = await resolveCheckoutRequestContext(req);
    const { tenantId } = context;
    locale = context.locale;
    clientUrl = context.clientUrl;
    const tenant = await getTenantOrThrow(tenantId);
    if (!tenant.modules?.courses || !tenant.modules?.payments) {
      forbidden({
        message: "Class checkout is unavailable for this workspace.",
        code: "TENANT_MODULE_REQUIRED",
      });
    }
    const user = await checkoutRepository.findUserByEmail({
      tenantId,
      email: getAuthenticatedUserEmail(req),
    });
    if (!user) return respondRedirect(res, clientUrl, locale);

    const entryId = String(req.params.entryId || "").trim();
    const operationKey = await getWaitlistOfferOperationKey({
      tenantId,
      customerId: String(user._id || user.id),
      email: String(user.email || ""),
      entryId,
    });
    const result = await checkoutService.createStripeCheckout({
      tenantId,
      user,
      cartItems: [],
      originUrl: clientUrl,
      currency: undefined,
      creditsToApplyMajor: 0,
      locale,
      membershipDiscountEligible: true,
      cancelPath: "portal/waitlists",
      idempotencyKey: waitlistIdempotencyKey({
        explicit: req.get("Idempotency-Key"),
        operationKey,
      }),
      waitlistEntryId: entryId,
    });
    return res.status(200).json({ url: result.url });
  } catch (error) {
    return handleCheckoutError(res, error, clientUrl, locale);
  }
};

export const checkoutWithCredits = async (
  req: CheckoutRequest,
  res: Response,
) => {
  if (req.body?.voucherCode)
    return res
      .status(400)
      .json({
        code: "VOUCHER_CREDIT_COMBINATION_UNSUPPORTED",
        message: "Use voucher checkout separately from account credits.",
      });
  let clientUrl = "";
  let locale = normalizeCommerceLocale(req.body?.locale);

  try {
    assertSupportedCheckoutInput(req.body);

    const cartItems = normalizeCartItems(req.body?.cart);
    const context = await resolveCheckoutRequestContext(req);
    const { tenantId } = context;
    locale = context.locale;
    clientUrl = context.clientUrl;
    const user = await checkoutRepository.findUserByEmail({
      tenantId,
      email: getAuthenticatedUserEmail(req),
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    const result = await checkoutService.checkoutWithCredits({
      tenantId,
      user,
      cartItems,
      originUrl: clientUrl,
      locale,
      idempotencyKey: req.get("Idempotency-Key"),
    });

    return res.json(result);
  } catch (error) {
    return handleCheckoutError(res, error, clientUrl, locale);
  }
};

export const getGuestCheckoutOrderStatus = async (
  req: CheckoutRequest,
  res: Response,
) => {
  const result = await getPublicGuestCourseOrderStatus({
    tenantId: requireTenantId(req),
    orderId: String(req.params.orderId || "").trim(),
  });

  if (!result) {
    return res.status(404).json({ message: "Payment order not found." });
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json(result);
};

export const stripeWebhook = async (req: CheckoutRequest, res: Response) => {
  try {
    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).send("Missing stripe-signature");

    const event = legacyPlatformCheckoutWebhookService.constructEvent({
      rawBody: req.body,
      signature,
    });

    if (!legacyPlatformCheckoutWebhookService.shouldProcess(event)) {
      return res.status(200).json({
        received: true,
        ignored: true,
        eventId: event.id,
      });
    }

    await legacyPlatformCheckoutWebhookService.processEvent(event);

    return res.status(200).json({
      received: true,
      legacyPlatformCheckout: true,
      eventId: event.id,
    });
  } catch (error) {
    console.error("[CHECKOUT_STRIPE_WEBHOOK_ERROR]", error);

    const message = getErrorMessage(error);

    if (message.toLowerCase().includes("signature")) {
      return res.status(400).send(`Webhook Error: ${message}`);
    }

    return res.status(500).send(`Webhook handler error: ${message}`);
  }
};

export const confirmIncreaseParticipants = async (
  req: CheckoutRequest,
  res: Response,
) => {
  try {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const { bookingId, additionalParticipants, stripeSessionId } = req.body;

    if (
      !mongoose.Types.ObjectId.isValid(String(bookingId)) ||
      !Number.isSafeInteger(Number(additionalParticipants)) ||
      Number(additionalParticipants) <= 0 ||
      typeof stripeSessionId !== "string" ||
      !stripeSessionId.trim()
    ) {
      return res.status(400).json({ message: "Missing parameters" });
    }

    const order = await Order.findOne({
      tenant: new mongoose.Types.ObjectId(tenantId),
      createdBy: new mongoose.Types.ObjectId(userId),
      "stripe.sessionId": stripeSessionId.trim(),
      guestIncreaseBookings: {
        $elemMatch: {
          bookingId: new mongoose.Types.ObjectId(String(bookingId)),
          addGuests: Number(additionalParticipants),
        },
      },
    })
      .select("_id status isPaid guestIncreaseBookings")
      .lean()
      .exec();

    if (!order) {
      return res.status(404).json({ message: "Payment order not found" });
    }

    if (order.status === "pending_order") {
      return res.status(202).json({
        message: "Payment or booking fulfillment is still being processed.",
        processed: false,
      });
    }

    if (!order.isPaid || order.status !== "processed_order") {
      return res.status(409).json({
        message: "Payment or booking fulfillment could not be completed.",
        processed: false,
        status: order.status,
      });
    }

    // Stripe webhook processing is the only code path that changes the guest
    // count. This success endpoint only confirms the caller-owned result, so a
    // replay cannot increment a booking twice.
    const booking = await Booking.findOne({
      tenant: new mongoose.Types.ObjectId(tenantId),
      _id: new mongoose.Types.ObjectId(String(bookingId)),
      createdBy: new mongoose.Types.ObjectId(userId),
      orders: order._id,
    })
      .lean()
      .exec();

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    return res.json({ message: "Booking updated", processed: true, booking });
  } catch (error) {
    console.error("[CHECKOUT_CONFIRM_INCREASE_PARTICIPANTS_ERROR]", error);
    return res.status(500).json({ message: "Failed to update booking" });
  }
};

export const getCheckoutOrderStatus = async (
  req: CheckoutRequest,
  res: Response,
) => {
  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);
  const orderId = String(req.params.orderId || "").trim();

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(404).json({ message: "Payment order not found." });
  }

  const order = await checkoutRepository.findCustomerOrderStatus({
    tenantId,
    orderId,
    userId,
  });

  if (!order) {
    return res.status(404).json({ message: "Payment order not found." });
  }

  const status = String(order.status || "pending_order");
  const orderType =
    Number(order.creditPurchase?.amount || 0) > 0
      ? "credit-purchase"
      : "commerce";
  const processing = status === "pending_order" && order.isPaid === true;

  return res.status(200).json({
    orderId: String(order._id),
    status,
    isPaid: order.isPaid === true,
    terminal: status !== "pending_order",
    processing,
    orderType,
  });
};

export const requestRefundParticipants = async (
  req: CheckoutRequest,
  res: Response,
) => {
  try {
    const tenantId = requireTenantId(req);
    const userId = getAuthenticatedUserId(req);
    const { bookingId } = req.body;
    const message =
      typeof req.body.message === "string" ? req.body.message.trim() : "";

    if (
      !mongoose.Types.ObjectId.isValid(String(bookingId)) ||
      !message ||
      message.length > 2000
    ) {
      return res.status(400).json({ message: "Missing parameters" });
    }

    const user = await User.findOne({
      tenant: new mongoose.Types.ObjectId(tenantId),
      _id: new mongoose.Types.ObjectId(userId),
    })
      .select("firstname lastname email")
      .lean()
      .exec();

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const bookingRepository = createBookingRepository({ tenantId });

    const booking = await bookingRepository.findByIdWithProduct(bookingId);

    if (!booking || String(booking.createdBy) !== userId) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const productName =
      typeof booking.bookingProduct === "object" &&
      "name" in booking.bookingProduct
        ? booking.bookingProduct.name
        : "";

    await sendEmail({
      from: process.env.AUTH_EMAIL || "no-reply@shario.io",
      to: process.env.ADMIN_EMAIL || "support@shario.io",
      subject: `Refund Request: Booking ${bookingId}`,
      text: `User ${user.firstname} ${user.lastname} (${user.email}) requests a refund for booking ${bookingId} (${productName}).\n\nMessage: ${message}`,
    });

    return res.json({ message: "Refund request sent" });
  } catch (error) {
    console.error("[CHECKOUT_REQUEST_REFUND_PARTICIPANTS_ERROR]", error);
    return res.status(500).json({ message: "Failed to request refund" });
  }
};
