import mongoose from "mongoose";
import Booking from "@/modules/booking/booking.model.js";
import Location from "@/modules/location/location.model.js";
import Product from "@/modules/product/product.model.js";
import Order from "@/modules/order/order.model.js";
import User from "@/modules/user/user.model.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { isGuestCourseCheckoutEnabled } from "@/modules/tenants/public-site/tenant-course-visibility.js";
import { AppError } from "@/shared/http/AppError.js";
import { acquireCheckoutOperation, completeCheckoutOperation, releaseCheckoutOperation, hashCheckoutRequest } from "../checkout-idempotency.service.js";
import {
  buildGuestCheckoutReturnUrl, createGuestCheckoutAccess, deriveGuestAccessToken,
  deriveGuestCheckoutUserId, verifyGuestCheckoutAccess,
} from "../checkout.guest-access.js";
import { parseGuestCourseCheckout, parseGuestCourseVoucherQuote } from "../checkout.guest-validation.js";
import { getPublishedGuestCourseLegalLinks } from "../checkout.guest-consent.js";
import { normalizeCommerceLocale, resolveTenantCommerceOrigin } from "../checkout.urls.js";
import { checkoutService } from "./checkout.service.js";

const accessFields = "+guestCourseCheckout.accessNonce +guestCourseCheckout.accessTokenHash +guestCourseCheckout.accessExpiresAt";
const unavailable = () => new AppError({
  statusCode: 404, code: "GUEST_COURSE_CHECKOUT_UNAVAILABLE",
  message: "Guest course checkout is unavailable for this studio.",
});
const purchaseNotFound = () => new AppError({
  statusCode: 404, code: "GUEST_COURSE_ORDER_NOT_FOUND",
  message: "Payment order access was not found or has expired.",
});
const expiredAttempt = () => new AppError({
  statusCode: 409, code: "GUEST_CHECKOUT_ATTEMPT_EXPIRED",
  message: "This payment attempt has ended. Start a new checkout.",
});

const guestVoucherError = (error: unknown) => {
  if (!(error instanceof AppError)) return error;
  if (error.code === "VOUCHER_LEGACY_REDEMPTION_REQUIRED") return new AppError({
    statusCode: 409, code: error.code,
    message: "This voucher needs studio review before it can be used online.",
  });
  if (["VOUCHER_NOT_FOUND", "VOUCHER_EXPIRED", "VOUCHER_UNAVAILABLE", "VOUCHER_INSUFFICIENT_BALANCE"].includes(error.code || ""))
    return new AppError({ statusCode: 409, code: "VOUCHER_UNAVAILABLE",
      message: "This voucher cannot be used for this booking. Check the code or contact the studio.",
    });
  return error;
};

const findProtectedOrder = (tenantId: string, orderId: string) =>
  Order.findOne({
    _id: orderId, tenant: tenantId, "guestCourseCheckout.version": 1,
    "courseBookings.0": { $exists: true },
  }).select(`_id tenant createdBy customer status isPaid guestCourseCheckout.version guestCourseCheckout.locale guestCourseCheckout.acceptedTerms guestCourseCheckout.returnContext stripe.sessionId ${accessFields}`).lean().exec();

export const getProtectedGuestCourseOrderStatus = async ({
  tenantId, orderId, accessToken,
}: { tenantId: string; orderId: string; accessToken: unknown }) => {
  if (!/^[a-f0-9]{24}$/i.test(orderId)) throw purchaseNotFound();
  const order = await findProtectedOrder(tenantId, orderId);
  if (!order || !verifyGuestCheckoutAccess(accessToken, order.guestCourseCheckout))
    throw purchaseNotFound();
  const status = String(order.status || "pending_order");
  return {
    orderId: String(order._id), status, isPaid: order.isPaid === true,
    terminal: status !== "pending_order",
    processing: status === "pending_order" && order.isPaid === true,
    orderType: "guest-course",
  };
};

// Quote and purchase share the same public course/location boundary. A quote
// never creates an identity, order, capacity hold or voucher reservation.
const loadGuestCourseSelection = async (
  tenantId: string,
  item: ReturnType<typeof parseGuestCourseCheckout>["cart"][number],
) => {
  const [product, slot] = await Promise.all([
    Product.findOne({
      _id: item.product._id, tenant: tenantId, isActive: true, isArchived: { $ne: true },
      type: { $in: ["course", "public-course"] },
    }).lean().exec(),
    Booking.findOne({
      _id: item.bookingCourse, tenant: tenantId,
      bookingProduct: item.product._id, tag: { $in: ["class", "course"] },
      archive: { $ne: true }, status: { $ne: "cancelled" },
      start: { $gt: new Date() },
    }).lean().exec(),
  ]);
  if (!product || !slot || product.type !== item.product.type || !slot.location) throw unavailable();
  const locationId = String(slot.location);
  const location = await Location.findOne({
    _id: slot.location, tenant: tenantId, isActive: true,
  }).select("_id").lean().exec();
  const publishedLocations = product.courseContent?.locationIds || [];
  if (!location || (item.locationId && item.locationId !== locationId) ||
      (product.location && String(product.location) !== locationId) ||
      (publishedLocations.length > 0 && !publishedLocations.some((id) => String(id) === locationId))) throw unavailable();
  const canonicalItem = { ...item, locationId, product: {
    _id: String(product._id), type: product.type, kind: "class",
  } };
  return { product, slot, locationId, canonicalItem };
};

export const quotePublicGuestCourseVoucher = async ({ tenantId, body }: { tenantId: string; body: unknown }) => {
  const input = parseGuestCourseVoucherQuote(body);
  const tenant = await getTenantOrThrow(tenantId);
  if (!isGuestCourseCheckoutEnabled(tenant) ||
      tenant.modules?.courses !== true || tenant.modules?.payments !== true) throw unavailable();
  const { product, canonicalItem } = await loadGuestCourseSelection(tenantId, input.cart[0]);
  return checkoutService.quoteVoucherCheckout({
    tenantId, cartItems: [canonicalItem], voucherCode: input.promoCode,
    currency: product.currency, membershipDiscountEligible: false,
    // A transient identifier prevents quote errors from exposing an existing
    // customer's pending order based only on possession of a voucher code.
    user: { _id: new mongoose.Types.ObjectId() },
  }).catch((error) => { throw guestVoucherError(error); });
};

export const createPublicGuestCourseCheckout = async ({
  tenantId, body, idempotencyKey, requestedOrigin,
}: { tenantId: string; body: unknown; idempotencyKey: unknown; requestedOrigin?: unknown }) => {
  const input = parseGuestCourseCheckout(body, idempotencyKey);
  const tenant = await getTenantOrThrow(tenantId);
  if (!isGuestCourseCheckoutEnabled(tenant) ||
      tenant.modules?.courses !== true || tenant.modules?.payments !== true) throw unavailable();
  const locale = normalizeCommerceLocale(input.locale);
  const originUrl = resolveTenantCommerceOrigin({
    tenant, requestedOrigin: requestedOrigin || input.origin,
  });
  const guestId = deriveGuestCheckoutUserId(tenantId, input.key);
  // The key is tenant-bound and independent of email. Changing contact or cart
  // cannot read/reuse another contact's attempt, even when its key is known.
  const acquisition = await acquireCheckoutOperation({
    tenantId, userId: guestId, kind: "card", idempotencyKey: input.key,
    request: { flow: "guest-course-v1", cart: input.cart, contact: input.guestInfo, acceptedTerms: input.acceptedTerms === true, locale, originUrl,
      ...(input.promoCode ? { promoCode: input.promoCode, expectedVoucherQuote: input.expectedVoucherQuote } : {}),
    },
  });
  if (acquisition.type === "replay") {
    const order = await findProtectedOrder(tenantId, String(acquisition.response.orderId || ""));
    if (!order || String(order.createdBy) !== guestId) throw purchaseNotFound();
    if (!order.isPaid && order.status !== "pending_order") throw expiredAttempt();
    const accessToken = deriveGuestAccessToken(tenantId, String(order._id), order.guestCourseCheckout!.accessNonce);
    if (!verifyGuestCheckoutAccess(accessToken, order.guestCourseCheckout)) throw purchaseNotFound();
    const url = order.isPaid && order.guestCourseCheckout?.returnContext
      ? buildGuestCheckoutReturnUrl({
        origin: originUrl, locale, path: "checkout/success", orderId: String(order._id),
        accessToken, context: order.guestCourseCheckout.returnContext,
      }) : acquisition.response.url;
    return { url, orderId: String(order._id), accessToken,
      status: order.isPaid && order.status === "processed_order" ? "confirmed" : "requires_payment",
    };
  }
  const { lease } = acquisition;
  try {
    const item = input.cart[0];
    const { product, slot, locationId, canonicalItem } = await loadGuestCourseSelection(tenantId, item);
    const priorOrder = await findProtectedOrder(tenantId, String(lease.orderId));
    if (priorOrder && String(priorOrder.createdBy) !== guestId) throw purchaseNotFound();
    if (priorOrder && !priorOrder.isPaid && priorOrder.status !== "pending_order") throw expiredAttempt();
    const legal = getPublishedGuestCourseLegalLinks(tenant);
    const requiresConsent = Boolean(legal.terms || legal.cancellation);
    // Recovering a saved order keeps its original consent evidence, even if
    // the studio has since changed its published links.
    if (!priorOrder?.guestCourseCheckout && requiresConsent && !input.acceptedTerms) throw new AppError({
      statusCode: 400, code: "GUEST_COURSE_TERMS_REQUIRED",
      message: "Please accept the published terms and booking conditions.",
    });
    const customId = `G-${guestId.slice(0, 20)}`;
    // There is deliberately no auth email/password, no membership, and no
    // session. Existing customers with this contact email remain untouched.
    await User.updateOne(
      { _id: guestId, tenant: new mongoose.Types.ObjectId(tenantId) },
      { $setOnInsert: {
        tenant: new mongoose.Types.ObjectId(tenantId),
        firstname: input.guestInfo.firstName, lastname: input.guestInfo.lastName,
        phone: input.guestInfo.phone || "", customId,
        tenantRole: "customer", platformRole: "none",
        isAccessGranted: false, isEmailVerified: false,
        guestContact: { email: input.guestInfo.email, locale, checkoutOrderId: lease.orderId },
      } },
      { upsert: true, runValidators: true },
    ).exec();
    const guest = await User.findOne({
      _id: guestId, tenant: tenantId, customId, isAccessGranted: false,
      email: { $exists: false }, tenantRole: "customer", platformRole: "none",
      "guestContact.checkoutOrderId": lease.orderId,
    }).select("_id").lean().exec();
    if (!guest) throw expiredAttempt();
    const issued = createGuestCheckoutAccess({
      tenantId, orderId: String(lease.orderId), key: input.key, locale,
    });
    const context = {
      productId: String(product._id), courseSessionId: String(slot._id),
      location: locationId, quantity: String(item.quantity),
    };
    const snapshot = priorOrder?.guestCourseCheckout || {
      ...issued.snapshot,
      ...(requiresConsent && input.acceptedTerms ? { acceptedTerms: {
        acceptedAt: new Date(),
        contentHash: hashCheckoutRequest({ productId: String(product._id), locale, legal }),
      } } : {}),
      returnContext: context,
    };
    const accessToken = deriveGuestAccessToken(tenantId, String(lease.orderId), snapshot.accessNonce);
    if (!verifyGuestCheckoutAccess(accessToken, snapshot)) throw purchaseNotFound();
    const returns = { origin: originUrl, locale, orderId: String(lease.orderId), accessToken, context };
    const result = await checkoutService.createStripeCheckout({
      tenantId, user: {
        _id: guest._id, firstname: input.guestInfo.firstName,
        lastname: input.guestInfo.lastName, email: input.guestInfo.email,
        phone: input.guestInfo.phone || "", customId,
      },
      cartItems: [canonicalItem], originUrl, currency: product.currency,
      locale, checkoutOperation: lease,
      voucherCode: input.promoCode || "", expectedVoucherQuote: input.expectedVoucherQuote,
      guestCheckout: {
        orderSnapshot: snapshot,
        successUrl: buildGuestCheckoutReturnUrl({ ...returns, path: "checkout/success" }),
        cancelUrl: buildGuestCheckoutReturnUrl({ ...returns, path: "checkout/cancel" }),
      },
    });
    if (!result.url) throw new Error("Guest checkout did not return a payment URL.");
    const response = { url: result.url, orderId: String(lease.orderId) };
    // The bearer itself is never stored in the operation replay response.
    // Full voucher fulfillment already commits the operation with its order
    // and reservation in one transaction. Its replay record excludes the proof.
    if (result.status !== "confirmed") await completeCheckoutOperation(lease, response);
    return { ...response, accessToken, status: result.status === "confirmed" ? "confirmed" : "requires_payment" };
  } catch (error) {
    await releaseCheckoutOperation(lease);
    throw guestVoucherError(error);
  }
};
