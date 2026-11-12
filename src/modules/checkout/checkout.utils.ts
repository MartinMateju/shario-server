import { normalizeOrigin } from "../../config/allowed-origins.js";
import { safeQty } from "@/infrastructure/payments/stripe-pricing.js";
import mongoose from "mongoose";
import { badRequest } from "@/shared/http/httpErrors.js";

import type { CheckoutCartItem } from "./checkout.types.js";
import {
  COURSE_RESERVATION_SAFETY_MINUTES,
  STRIPE_CHECKOUT_SESSION_MINUTES,
  WORKSHOP_RESERVATION_GRACE_MINUTES,
} from "./checkout.constants.js";

export const getStripeCheckoutExpiryWindow = (
  nowMs = Date.now(),
): {
  sessionExpiresAtSeconds: number;
  sessionExpiresAt: Date;
  workshopReservationExpiresAt: Date;
  courseReservationExpiresAt: Date;
} => {
  const sessionExpiresAtSeconds =
    Math.floor(nowMs / 1000) + STRIPE_CHECKOUT_SESSION_MINUTES * 60;

  return {
    sessionExpiresAtSeconds,
    sessionExpiresAt: new Date(sessionExpiresAtSeconds * 1000),
    workshopReservationExpiresAt: new Date(
      (sessionExpiresAtSeconds + WORKSHOP_RESERVATION_GRACE_MINUTES * 60) *
        1000,
    ),
    // Stripe can deliver an already-paid completion event after an outage.
    // Keep course seats fail-closed for a safety window and release them
    // explicitly on checkout.session.expired. Stale holds are ignored after
    // this TTL and removed by the next atomic reservation update.
    courseReservationExpiresAt: new Date(
      (sessionExpiresAtSeconds + COURSE_RESERVATION_SAFETY_MINUTES * 60) * 1000,
    ),
  };
};

export const normalizeCartItems = (cart: unknown): CheckoutCartItem[] => {
  if (Array.isArray(cart)) return cart as CheckoutCartItem[];
  if (cart && typeof cart === "object") {
    return Object.values(cart) as CheckoutCartItem[];
  }
  return [];
};

export const getProductIdsFromCart = (cartItems: CheckoutCartItem[] = []) =>
  [
    ...new Set(
      cartItems
        .map((item) => item?.product?._id)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        .map(String),
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

export const getLocationIdsFromCart = (cartItems: CheckoutCartItem[] = []) =>
  [
    ...new Set(
      cartItems
        .filter((item) => {
          const type = String(item?.product?.type || "")
            .trim()
            .toLowerCase();
          const kind = String(item?.product?.kind || "")
            .trim()
            .toLowerCase();
          return (
            kind === "open-studio" ||
            type.includes("workshop") ||
            type === "service"
          );
        })
        .map((item) => item?.locationId)
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        .map(String),
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

export const getCartItemBlocks30m = (cartItem: CheckoutCartItem): number => {
  /*
   * Timed products are always priced from their server-validated range.
   * `quantity` remains a compatibility field for non-timed products, but it
   * must never let a client buy one block and reserve several hours.
   */
  if (cartItem?.start && cartItem?.end) {
    const start = new Date(cartItem.start).getTime();
    const end = new Date(cartItem.end).getTime();
    const duration = end - start;

    if (Number.isFinite(duration) && duration > 0) {
      return Math.ceil(duration / (30 * 60 * 1000));
    }
  }

  const quantity = Number(cartItem?.quantity);
  if (Number.isFinite(quantity) && quantity > 0) return Math.ceil(quantity);
  return 1;
};

export const getAddedGuestsFromCartItem = (
  cartItem: CheckoutCartItem,
): number => {
  const raw =
    cartItem?.numberOfGuests ??
    cartItem?.addGuests ??
    cartItem?.additionalParticipants ??
    cartItem?.additionalGuests ??
    cartItem?.participantsToAdd;

  const n = Math.floor(Number(raw || 0));
  return Number.isFinite(n) ? n : 0;
};

export const getWorkshopPeople = (cartItem: CheckoutCartItem): number =>
  Math.max(1, Math.floor(Number(cartItem?.numberOfGuests || 1)));

export const getOpenStudioBookingMode = (
  cartItem: CheckoutCartItem,
  serverProduct?: {
    type?: unknown;
    kind?: unknown;
    bookingMode?: unknown;
  } | null,
): "public" | "private" => {
  if (serverProduct) {
    const serverMode = String(serverProduct.bookingMode || "")
      .trim()
      .toLowerCase();
    const serverKind = String(serverProduct.kind || "")
      .trim()
      .toLowerCase();
    const serverType = String(serverProduct.type || "")
      .trim()
      .toLowerCase();

    if (serverMode === "public" || serverMode === "private") {
      return serverMode;
    }

    if (serverMode === "customer-choice") {
      const requestedMode = cartItem?.bookingMode ?? cartItem?.bookingType;
      if (requestedMode === "public" || requestedMode === "private") {
        return requestedMode;
      }
      badRequest({
        message: "Choose a public or private booking.",
        code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED",
      });
    }

    if (serverType === "private-workshop") return "private";
    if (serverType === "public-workshop") return "public";
    if (serverType === "workshop") return "public";

    if (serverKind === "open-studio") {
      badRequest({
        message: "Open Studio does not have a booking mode configured.",
        code: "OPEN_STUDIO_BOOKING_MODE_REQUIRED",
      });
    }
  }

  const fixedMode =
    cartItem?.bookingMode ??
    cartItem?.product?.bookingMode ??
    cartItem?.bookingType;

  return String(fixedMode || "private").toLowerCase() === "public"
    ? "public"
    : "private";
};

/** @deprecated Use getOpenStudioBookingMode. */
export const getWorkshopBookingType = getOpenStudioBookingMode;

export const getGuestIncreaseBookingId = (cartItem: CheckoutCartItem) =>
  cartItem?.bookingWorkshop ||
  cartItem?.bookingRef ||
  cartItem?.bookingId ||
  cartItem?.booking;

export const getCartItemNumberOfPeople = (
  cartItem: CheckoutCartItem,
  productType = "",
): number => {
  const type = String(productType || "").toLowerCase();
  const n = Number(cartItem?.numberOfGuests);

  if (type.includes("course") || type === "class") {
    const q = Number(cartItem?.quantity);
    if (Number.isFinite(q) && q > 0) return Math.max(1, Math.floor(q));
    return 1;
  }

  if (type === "guest-increase") {
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
    return 1;
  }

  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
  return 1;
};

export const getCartItemBillableUnits = (
  cartItem: CheckoutCartItem,
  productType = "",
): number => {
  const type = String(productType || "").toLowerCase();

  if (type.includes("course") || type === "class") {
    return getCartItemNumberOfPeople(cartItem, type);
  }

  if (type === "guest-increase") {
    const quantity = safeQty(cartItem?.quantity || 1);
    const guests = Math.max(1, getAddedGuestsFromCartItem(cartItem) || 1);
    return quantity * guests;
  }

  return (
    getCartItemBlocks30m(cartItem) * getCartItemNumberOfPeople(cartItem, type)
  );
};

export const normalizePlannedActivity = (
  cartItem: CheckoutCartItem,
): string => {
  const allowed = new Set(["WORKSTATION", "SHARED_TABLE", "UNDEFINED"]);

  const values = Array.isArray(cartItem?.plannedActivities)
    ? cartItem.plannedActivities
    : Array.isArray(cartItem?.plannedActivity)
      ? cartItem.plannedActivity
      : cartItem?.plannedActivity != null
        ? [cartItem.plannedActivity]
        : [];

  const candidate = String(values?.[0] || "")
    .trim()
    .toUpperCase();

  return allowed.has(candidate) ? candidate : "UNDEFINED";
};

export const resolveClientUrl = (origin?: string): string => {
  const normalized = normalizeOrigin(origin);

  if (normalized) {
    return normalized;
  }

  if (process.env.CLIENT_URL) return process.env.CLIENT_URL;

  return process.env.PUBLIC_APP_URL || "https://app.shario.io";
};

export const redirectPayload = (
  clientUrl: string,
  path = "/rezervace/cancel",
): string => JSON.stringify({ url: `${clientUrl}${path}` });
