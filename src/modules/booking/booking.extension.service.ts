import { canExtendBooking } from "./booking.extension.policy.js";
export { canExtendBooking } from "./booking.extension.policy.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { recordBookingLifecycleEmailInSession } from "./services/booking.customer-notification.service.js";
import { createHash } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import Booking from "./booking.model.js";
import { Product } from "@/modules/product/product.model.js";
import { LocationModel } from "@/modules/location/location.model.js";
import { Order } from "@/modules/order/order.model.js";
import { CheckoutOperationModel } from "@/modules/checkout/checkout-operation.model.js";
import { loadCourseCapacityForBookings } from "./booking.course-capacity.js";
import { validateOpenStudioAvailabilityOrThrow } from "@/modules/checkout/services/checkout.capacity.service.js";
import { findLocationOpeningWindow } from "@/modules/location/location-opening-hours.js";
import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";
import { conflict, notFound } from "@/shared/http/httpErrors.js";

export const EXTENSION_MINUTES = [30, 60, 90, 120] as const;
export const EXTENSION_HOLD_TAG = "extension-hold";
const id = (value: any) => String(value?._id ?? value ?? "");
const time = (value: any) => new Date(value).getTime();
const fail = (code: string, message: string): never =>
  conflict({ code: `CUSTOMER_BOOKING_EXTENSION_${code}`, message });

/** Original discounted time rate, excluding the original one-off private fee. */
export const resolveExtensionPrice = (
  booking: any,
  product: any,
  orders: any[],
  minutes: number,
) => {
  const currency = normalizeStudioCommerceCurrency(product.currency);
  const baseEnd = booking.extensionBaseEnd || booking.end;
  const duration =
    Number(booking.extensionBaseDurationMinutes) ||
    (time(baseEnd) - time(booking.start)) / 60_000;
  for (const order of orders) {
    if (!order.isPaid || order.bookingExtension) continue;
    try {
      if (normalizeStudioCommerceCurrency(order.currency) !== currency)
        continue;
    } catch {
      continue;
    }
    // Membership allowances are not a reusable monetary discount. Quote the
    // catalog rate explicitly; never consume an extra allowance implicitly.
    if (
      order.paymentAllocations?.some(
        (allocation: any) => allocation.method === "membership_credit",
      )
    )
      continue;
    const lines = (order.lineItems || []).filter(
      (line: any) => id(line.booking) === id(booking),
    );
    const items = (order.cart?.cartItems || []).filter(
      (item: any) => id(item.product) === id(product),
    );
    if (lines.length !== 1 || items.length !== 1 || !(duration > 0)) continue;
    const item = items[0];
    let total: number;
    let base: number;
    try {
      total = toCurrencyMinorUnits(Number(item.totalPrice), currency);
      base = toCurrencyMinorUnits(
        Number(item.basePrice) * Number(item.quantity),
        currency,
      );
    } catch {
      continue;
    }
    const paid = Number(lines[0].grossAmountMinor);
    const originalGuests = Number(item.numberOfPeople);
    const currentGuests = Math.max(1, Number(booking.numberOfGuests) || 1);
    if (
      total > 0 &&
      Number.isSafeInteger(originalGuests) &&
      originalGuests > 0 &&
      base >= 0 &&
      Number.isSafeInteger(paid) &&
      paid >= 0 &&
      paid <= total
    ) {
      return {
        currency,
        amountMinor: Math.round(
          base *
            (paid / total) *
            (minutes / duration) *
            (currentGuests / originalGuests),
        ),
        pricingSource: "original_booking",
      };
    }
  }
  return {
    currency,
    amountMinor: toCurrencyMinorUnits(
      Number(product.price) *
        (minutes / 30) *
        Math.max(1, Number(booking.numberOfGuests) || 1),
      currency,
    ),
    pricingSource: "current_price",
  };
};

export const assertExtensionHours = (
  booking: any,
  location: any,
  end: Date,
) => {
  const timezone = String(location.booking?.timezone || "Europe/Prague");
  const range = findLocationOpeningWindow({
    start: new Date(booking.start),
    end,
    openingHours: location.openingHours,
    timezone,
  });
  if (
    !range ||
    time(booking.start) < time(range.start) ||
    time(end) > time(range.end)
  )
    fail(
      "OUTSIDE_HOURS",
      "The extension would finish outside studio opening hours.",
    );
  const maximum = Number(location.booking?.maxBookingMinutes);
  if (maximum > 0 && time(end) - time(booking.start) > maximum * 60_000)
    fail(
      "DURATION_LIMIT",
      "The extended booking would exceed the studio maximum duration.",
    );
};

const loadExtensionContext = async (
  tenantId: string,
  userId: string,
  bookingId: string,
  session: ClientSession | null = null,
) => {
  if (!mongoose.isValidObjectId(bookingId)) notFound("Booking not found.");
  const booking: any = await Booking.findOne({
    _id: bookingId,
    tenant: tenantId,
    createdBy: userId,
    tag: { $in: ["open-studio", "workshop"] },
  })
    .session(session)
    .lean();
  if (!booking) notFound("Booking not found.");
  const product: any = await Product.findOne({
    _id: booking.bookingProduct,
    tenant: tenantId,
    isActive: true,
    isArchived: { $ne: true },
  })
    .session(session)
    .lean();
  const location: any = await LocationModel.findOne({
    _id: booking.location,
    tenant: tenantId,
    isActive: true,
    "booking.enabled": true,
  })
    .session(session)
    .lean();
  if (!product || !location)
    fail("NOT_ALLOWED", "This booking's product or location is unavailable.");
  const orders: any[] = await Order.find({
    _id: { $in: booking.orders || [] },
    tenant: tenantId,
    isPaid: true,
  })
    .sort({ createdAt: 1, _id: 1 })
    .populate("cart")
    .session(session)
    .lean();
  return { booking, product, location, orders };
};

const versionFor = ({ booking, product, orders }: any) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        booking: id(booking),
        start: booking.start,
        end: booking.end,
        mode: booking.bookingMode ?? booking.bookingType,
        guests: booking.numberOfGuests,
        activity: booking.plannedActivity,
        publicCapacityLimit: booking.publicCapacityLimit,
        customerChoiceBooking: booking.customerChoiceBooking,
        rate: resolveExtensionPrice(booking, product, orders, 30),
      }),
    )
    .digest("hex");

const matchesExtensionSnapshot = (booking: any, hold: any) =>
  id(booking.location) === id(hold.location) &&
  id(booking.bookingProduct) === id(hold.bookingProduct) &&
  Number(booking.numberOfGuests) === Number(hold.numberOfGuests) &&
  (Number(booking.publicCapacityLimit) || null) ===
    (Number(hold.publicCapacityLimit) || null) &&
  Boolean(booking.customerChoiceBooking) ===
    Boolean(hold.customerChoiceBooking) &&
  (booking.bookingMode ?? booking.bookingType) ===
    (hold.bookingMode ?? hold.bookingType) &&
  String(booking.plannedActivity || "") === String(hold.plannedActivity || "");

const capacityForExtension = async ({
  tenantId,
  booking,
  location,
  end,
  session = null,
  excludeHold = "",
}: any) => {
  const current: any[] = await Booking.find({
    tenant: tenantId,
    location: booking.location,
    _id: { $nin: [booking._id, ...(excludeHold ? [excludeHold] : [])] },
    start: { $lt: end },
    end: { $gt: booking.end },
  })
    .session(session)
    .lean();
  await loadCourseCapacityForBookings({ bookings: current, tenantId, session });
  validateOpenStudioAvailabilityOrThrow({
    openStudioBookings: [
      { ...(booking.toObject?.() || booking), start: booking.end, end },
    ],
    currentBookings: current,
    locationById: new Map([[id(location), location]]),
  });
};

export const getBookingExtensionOptions = async ({
  tenantId,
  userId,
  bookingId,
  now = new Date(),
}: any) => {
  const context = await loadExtensionContext(tenantId, userId, bookingId);
  const { booking, product, location, orders } = context;
  const canExtend = canExtendBooking(booking, now);
  const paymentMethods =
    time(booking.end) >= now.getTime() + 36 * 60_000
      ? ["credits", "card"]
      : ["credits"];
  const pending =
    time(booking.extensionPaymentPendingUntil) > now.getTime() &&
    booking.extensionPaymentOrder
      ? await CheckoutOperationModel.findOne({
          tenant: tenantId,
          user: userId,
          orderId: booking.extensionPaymentOrder,
        }).lean()
      : null;
  const options = [];
  for (const minutes of EXTENSION_MINUTES) {
    const end = new Date(time(booking.end) + minutes * 60_000);
    const price = resolveExtensionPrice(booking, product, orders, minutes);
    let reason: string | null = null;
    try {
      if (!canExtend)
        fail(
          time(booking.extensionPaymentPendingUntil) > now.getTime()
            ? "PENDING"
            : "NOT_ALLOWED",
          "This booking cannot currently be extended.",
        );
      assertExtensionHours(booking, location, end);
      await capacityForExtension({ tenantId, booking, location, end });
    } catch (error: any) {
      if (!error.isOperational) throw error;
      reason =
        error.errorCode ||
        error.code ||
        "CUSTOMER_BOOKING_EXTENSION_UNAVAILABLE";
    }
    options.push({
      minutes,
      end: end.toISOString(),
      available: !reason,
      reason,
      ...price,
    });
  }
  return {
    bookingId,
    currentEnd: new Date(booking.end).toISOString(),
    canExtend,
    currency: normalizeStudioCommerceCurrency(product.currency),
    quoteVersion: versionFor(context),
    paymentMethods,
    cardUnavailableReason: paymentMethods.includes("card")
      ? null
      : "CUSTOMER_BOOKING_EXTENSION_CARD_WINDOW",
    paymentMethodReasons: paymentMethods.includes("card")
      ? {}
      : { card: "CUSTOMER_BOOKING_EXTENSION_CARD_WINDOW" },
    pendingExtension:
      time(booking.extensionPaymentPendingUntil) > now.getTime()
        ? {
            orderId: id(booking.extensionPaymentOrder),
            url: pending?.response?.url || null,
            expiresAt: booking.extensionPaymentPendingUntil,
          }
        : null,
    pricingSource: options[0].pricingSource,
    options,
  };
};

/** Rebuild untrusted cart input before either checkout payment path prices it. */
export const normalizeExtensionCart = async ({
  tenantId,
  userId,
  cartItems,
  paymentMethod,
}: any) => {
  const extensions = cartItems.filter((item: any) => item.bookingExtension);
  if (!extensions.length) return cartItems;
  if (cartItems.length !== 1)
    fail("INVALID", "Pay for one booking extension at a time.");
  const request = extensions[0].bookingExtension;
  const context = await loadExtensionContext(
    String(tenantId),
    id(userId),
    String(request.bookingId),
  );
  const { booking, product, location, orders } = context;
  if (!canExtendBooking(booking))
    fail("NOT_ALLOWED", "This booking cannot currently be extended.");
  if (!EXTENSION_MINUTES.includes(request.minutes))
    fail("INVALID", "Choose 30, 60, 90 or 120 minutes.");
  if (
    new Date(booking.end).toISOString() !== request.expectedEnd ||
    versionFor(context) !== request.quoteVersion
  )
    fail(
      "STALE",
      "The booking or its price changed. Refresh the extension options.",
    );
  if (paymentMethod === "card" && time(booking.end) < Date.now() + 36 * 60_000)
    fail(
      "CARD_WINDOW",
      "Card checkout needs at least 36 minutes before your booking ends. Use credits instead.",
    );
  const price = resolveExtensionPrice(
    booking,
    product,
    orders,
    request.minutes,
  );
  if (price.amountMinor !== request.expectedAmountMinor)
    fail("PRICE_CHANGED", "The extension price changed. Review the new price.");
  const end = new Date(time(booking.end) + request.minutes * 60_000);
  assertExtensionHours(booking, location, end);
  await capacityForExtension({ tenantId, booking, location, end });
  return [
    {
      product,
      bookingWorkshop: booking._id,
      locationId: booking.location,
      start: booking.end,
      end,
      numberOfGuests: booking.numberOfGuests,
      bookingMode: booking.bookingMode ?? booking.bookingType,
      bookingType: booking.bookingMode ?? booking.bookingType,
      plannedActivity: booking.plannedActivity,
      language: extensions[0].language,
      bookingExtension: {
        ...request,
        amountMinor: price.amountMinor,
        currency: price.currency,
        originalStart: booking.start,
        originalEnd: booking.end,
        publicCapacityLimit: booking.publicCapacityLimit,
        customerChoiceBooking: booking.customerChoiceBooking,
      },
    },
  ];
};

/** Called after the existing location transaction lock, before inserting a hold. */
export const lockExtensionTargets = async ({
  tenantId,
  payloads,
  session,
}: any) => {
  for (const hold of payloads.filter((payload: any) => payload.extensionFor)) {
    const booking: any = await Booking.findOne({
      _id: hold.extensionFor,
      tenant: tenantId,
      createdBy: hold.createdBy,
    }).session(session);
    if (
      !booking ||
      !canExtendBooking(booking) ||
      time(booking.end) !== time(hold.start) ||
      time(booking.start) !== time(hold.extensionOriginalStart) ||
      !matchesExtensionSnapshot(booking, hold)
    )
      fail(
        "STALE",
        "The booking changed or another extension is awaiting payment.",
      );
    const context = await loadExtensionContext(
      String(tenantId),
      id(hold.createdBy),
      id(hold.extensionFor),
      session,
    );
    if (versionFor(context) !== hold.extensionQuoteVersion)
      fail(
        "STALE",
        "The booking or its price changed before payment. Refresh the extension options.",
      );
    const location = context.location;
    assertExtensionHours(booking, location, new Date(hold.end));
    booking.extensionPaymentPendingUntil = hold.paymentExpiresAt;
    booking.extensionPaymentOrder = hold.orders[0];
    await booking.save({ session });
  }
};

/** The hold is internal: payment extends the original reservation exactly once. */
export const fulfillBookingExtensions = async (
  order: any,
  { tenantId, session = null }: any,
) => {
  const run = async (activeSession: ClientSession) => {
    const holds: any[] = await Booking.find({
      tenant: tenantId,
      orders: order._id,
      tag: EXTENSION_HOLD_TAG,
    }).session(activeSession);
    if (order.bookingExtension && holds.length !== 1)
      fail("STALE", "The extension payment hold no longer exists.");
    for (const hold of holds) {
      if (hold.extensionApplied) continue;
      const booking: any = await Booking.findOne({
        _id: hold.extensionFor,
        tenant: tenantId,
        createdBy: hold.createdBy,
      }).session(activeSession);
      if (booking && time(booking.end) <= Date.now())
        fail(
          "ENDED",
          "The booking ended before the extension payment was confirmed.",
        );
      if (
        !booking ||
        booking.archive === true ||
        id(booking.extensionPaymentOrder) !== id(order) ||
        time(hold.paymentExpiresAt) <= Date.now() ||
        !["processed", "delivered"].includes(booking.status) ||
        booking.paymentStatus !== "CONFIRMED" ||
        time(booking.end) !== time(hold.start) ||
        time(booking.start) !== time(hold.extensionOriginalStart) ||
        !matchesExtensionSnapshot(booking, hold)
      )
        fail(
          "STALE",
          "The paid extension no longer matches the original booking.",
        );
      const lock = await LocationModel.updateOne(
        { _id: booking.location, tenant: tenantId },
        { $inc: { "booking.capacityRevision": 1 } },
        { session: activeSession },
      );
      if (lock.matchedCount !== 1)
        fail("UNAVAILABLE", "The studio no longer exists.");
      const location = await LocationModel.findOne({
        _id: booking.location,
        tenant: tenantId,
      })
        .session(activeSession)
        .lean();
      assertExtensionHours(booking, location, new Date(hold.end));
      await capacityForExtension({
        tenantId,
        booking,
        location,
        end: hold.end,
        excludeHold: hold._id,
        session: activeSession,
      });
      booking.extensionBaseDurationMinutes ||=
        (time(booking.end) - time(booking.start)) / 60_000;
      booking.extensionBaseEnd ||= booking.end;
      // End-based messages must follow the new paid end time. Existing sent or
      // provider-ambiguous records remain untouched; the scheduler discovers a
      // new occurrence using the updated end anchor.
      await CommunicationEmailLogModel.updateMany(
        {
          tenant: tenantId,
          relatedEntityType: "booking",
          relatedEntityId: booking._id,
          emailType: { $in: ["afterBooking", "afterPurchase"] },
          status: { $in: ["pending", "scheduled", "queued"] },
          providerAttemptStartedAt: null,
        },
        {
          $set: {
            status: "canceled",
            canceledAt: new Date(),
            cancelReason: "Booking was extended; follow the new end time.",
          },
        },
        { session: activeSession },
      );
      booking.end = hold.end;
      booking.numberOfHours =
        (time(booking.end) - time(booking.start)) / 3_600_000;
      booking.orders.addToSet(order._id);
      booking.extensionPaymentPendingUntil = null;
      booking.extensionPaymentOrder = null;
      await booking.save({ session: activeSession });
      hold.extensionApplied = true;
      hold.status = "cancelled";
      hold.paymentStatus = "CONFIRMED";
      await hold.save({ session: activeSession });
      await recordBookingLifecycleEmailInSession(
        {
          tenantId: String(tenantId),
          userId: id(booking.createdBy),
          bookingId: id(booking),
          event: "extended",
          transitionKey: id(order),
        },
        activeSession,
      );
      await Order.updateOne(
        { _id: order._id, tenant: tenantId },
        { $set: { workshopBookings: [booking._id] } },
        { session: activeSession },
      );
      order.workshopBookings = [booking._id];
    }
  };
  if (session) return run(session);
  await mongoose.connection.transaction(run);
};

export const releaseBookingExtensionHolds = async ({
  tenantId,
  orderId,
  session = null,
}: any) => {
  await Booking.updateMany(
    { tenant: tenantId, extensionPaymentOrder: orderId },
    {
      $set: { extensionPaymentPendingUntil: null, extensionPaymentOrder: null },
    },
    { session },
  );
  await Booking.updateMany(
    {
      tenant: tenantId,
      orders: orderId,
      tag: EXTENSION_HOLD_TAG,
      extensionApplied: { $ne: true },
    },
    { $set: { status: "cancelled", paymentStatus: "EXPIRED" } },
    { session },
  );
};

export const cancelPendingBookingExtension = async ({
  tenantId,
  userId,
  bookingId,
  orderId,
}: any) => {
  const booking = await Booking.findOne({
    _id: bookingId,
    tenant: tenantId,
    createdBy: userId,
  });
  if (!booking) notFound("Booking not found.");
  const order = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    createdBy: userId,
    "bookingExtension.bookingId": bookingId,
  }).lean();
  if (!order) notFound("Extension payment not found.");
  if (order.isPaid || order.status === "processed_order")
    fail(
      "PAYMENT_CONFIRMED",
      "Payment has already been confirmed. Refresh your booking.",
    );
  if (order.status === "cancelled_order") return { cancelled: true };
  if (!order.stripe?.sessionId || !order.stripe.connectedAccountId)
    fail("PENDING", "The payment is still being prepared. Try again shortly.");
  const { getTenantPaymentStripe, getConnectedAccountRequestOptions } =
    await import("@/modules/tenant-payments/tenant-payment.stripe.gateway.js");
  const stripe = getTenantPaymentStripe();
  const options = getConnectedAccountRequestOptions(
    order.stripe.connectedAccountId,
  );
  const payment = await stripe.checkout.sessions.retrieve(
    order.stripe.sessionId,
    options,
  );
  if (payment.payment_status === "paid" || payment.status === "complete")
    fail(
      "PAYMENT_CONFIRMED",
      "Payment has already been confirmed. Refresh your booking.",
    );
  const expired =
    payment.status === "expired"
      ? payment
      : await stripe.checkout.sessions.expire(payment.id, options);
  if (expired.status !== "expired")
    fail("PENDING", "The payment could not yet be cancelled.");
  const { checkoutRepository } =
    await import("@/modules/checkout/checkout.repository.js");
  await checkoutRepository.releaseExpiredStripeOrder({
    tenantId,
    orderId,
    sessionId: payment.id,
    connectedAccountId: order.stripe.connectedAccountId,
  });
  return { cancelled: true };
};
