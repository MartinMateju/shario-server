import mongoose from "mongoose";

import { getNumberOfHours } from "@/modules/booking/booking.utils.js";
import {
  BOOKING_STATUS,
  BOOKING_TAG,
  PAYMENT_STATUS,
  VALID_GUEST_PRODUCT_TYPES,
  VALID_PRODUCT_TYPES,
  MAX_COURSE_PARTICIPANTS_PER_CHECKOUT,
  MAX_COURSE_PARTICIPANTS_PER_ITEM,
  MAX_GUEST_INCREASE_BLOCKS,
  MAX_GUEST_INCREASE_PER_ITEM,
  STRIPE_CHECKOUT_SESSION_MINUTES,
  WORKSHOP_RESERVATION_GRACE_MINUTES,
} from "@/modules/checkout/checkout.constants.js";
import {
  getAddedGuestsFromCartItem,
  getGuestIncreaseBookingId,
  getLocationIdsFromCart,
  getProductIdsFromCart,
  getWorkshopBookingType,
  getWorkshopPeople,
  normalizePlannedActivity,
} from "@/modules/checkout/checkout.utils.js";
import { badRequest, conflict } from "@/shared/http/httpErrors.js";
import { resolveProductPublicCapacityLimit } from "@/modules/product/product.utils.js";
import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";

const isOpenStudioCartItem = (cartItem) => {
  const kind = String(cartItem?.product?.kind || "")
    .trim()
    .toLowerCase();
  const type = String(cartItem?.product?.type || "")
    .trim()
    .toLowerCase();

  return (
    kind === "open-studio" ||
    type.includes("workshop") ||
    (type === "service" && Boolean(cartItem?.start) && Boolean(cartItem?.end))
  );
};

const isClassCartItem = (cartItem) => {
  const kind = String(cartItem?.product?.kind || "")
    .trim()
    .toLowerCase();
  const type = String(cartItem?.product?.type || "")
    .trim()
    .toLowerCase();

  return kind === "class" || type.includes("course");
};

export const assertValidCartProducts = ({
  cartItems,
  productById,
  allowCoupon = false,
}) => {
  const validTypes = allowCoupon
    ? VALID_GUEST_PRODUCT_TYPES
    : VALID_PRODUCT_TYPES;

  const invalidCartItems = cartItems.filter((cartItem) => {
    const type = cartItem?.product?.type;
    return !type || !validTypes.includes(type);
  });

  if (invalidCartItems.length > 0) {
    badRequest({
      message: "Invalid cart items.",
      code: "BAD_REQUEST",
      details: {
        reason: "INVALID_CART_ITEMS",
      },
    });
  }

  const missing = cartItems.some(
    (cartItem) => !productById.get(String(cartItem?.product?._id)),
  );

  if (missing) {
    badRequest({
      message: "Some products from cart were not found.",
      code: "BAD_REQUEST",
      details: {
        reason: "PRODUCT_NOT_FOUND",
      },
    });
  }

  const privateStudioItem = cartItems.find((cartItem) => {
    const dbProduct = productById.get(String(cartItem?.product?._id));
    const kind = String(dbProduct?.kind || "")
      .trim()
      .toLowerCase();
    const type = String(dbProduct?.type || "")
      .trim()
      .toLowerCase();

    return kind === "private-studio" || type === "blocker";
  });

  if (privateStudioItem) {
    badRequest({
      message: "Private Studio is internal and cannot be checked out.",
      code: "PRIVATE_STUDIO_NOT_SELLABLE",
    });
  }

  const typeMismatch = cartItems.some((cartItem) => {
    const dbProduct = productById.get(String(cartItem?.product?._id));
    return !dbProduct || dbProduct.type !== cartItem?.product?.type;
  });

  if (typeMismatch) {
    badRequest({
      message: "Product type mismatch between payload and DB.",
      code: "BAD_REQUEST",
      details: {
        reason: "PRODUCT_TYPE_MISMATCH",
      },
    });
  }

  // Validate the persisted product, never the browser's product snapshot. This
  // boundary applies only to new checkout selections; order recovery and paid
  // booking fulfillment continue to use their durable snapshots.
  for (const cartItem of cartItems) {
    assertStudioProductLocation(
      productById.get(String(cartItem?.product?._id)),
      cartItem.locationId,
    );
  }

  return true;
};

export const extractProductIdsOrThrow = (cartItems) => {
  const productIds = getProductIdsFromCart(cartItems);

  if (productIds.length === 0) {
    badRequest({
      message: "Cart contains no valid products.",
      code: "BAD_REQUEST",
      details: {
        reason: "EMPTY_PRODUCT_IDS",
      },
    });
  }

  return productIds;
};

export const extractLocationIdsOrThrow = (cartItems) => {
  const locationBoundItems = cartItems.filter((cartItem) => {
    const type = String(cartItem?.product?.type || "")
      .trim()
      .toLowerCase();
    return isOpenStudioCartItem(cartItem) || type === "service";
  });

  if (locationBoundItems.length === 0) return [];

  const hasInvalidLocation = locationBoundItems.some(
    (item) => !mongoose.Types.ObjectId.isValid(String(item?.locationId)),
  );

  if (hasInvalidLocation) {
    badRequest({
      message:
        "Every Open Studio booking and standalone service requires a valid locationId.",
      code: "BAD_REQUEST",
      details: { reason: "INVALID_LOCATION_ID" },
    });
  }

  return getLocationIdsFromCart(locationBoundItems);
};

export const assertValidCartLocations = ({ cartItems, locationById }) => {
  const missingLocation = cartItems
    .filter((item) => {
      const type = String(item?.product?.type || "")
        .trim()
        .toLowerCase();
      return isOpenStudioCartItem(item) || type === "service";
    })
    .find((item) => !locationById.has(String(item.locationId)));

  if (missingLocation) {
    badRequest({
      message: "The selected studio location is unavailable.",
      code: "BAD_REQUEST",
      details: {
        reason: "LOCATION_NOT_AVAILABLE",
        locationId: String(missingLocation.locationId || ""),
      },
    });
  }

  const disabledWorkshopLocation = cartItems
    .filter(isOpenStudioCartItem)
    .find((item) => {
      const location = locationById.get(String(item.locationId));
      return location && location.booking?.enabled !== true;
    });

  if (disabledWorkshopLocation) {
    badRequest({
      message: "Bookings are not enabled at the selected studio location.",
      code: "BAD_REQUEST",
      details: {
        reason: "LOCATION_BOOKING_DISABLED",
        locationId: String(disabledWorkshopLocation.locationId || ""),
      },
    });
  }

  return true;
};

export const buildOpenStudioBookingsToCreate = ({
  cartItems,
  productById,
  user,
  orderId = undefined,
  paymentMode = "stripe",
  paymentExpiresAt = undefined,
}) => {
  const now = new Date();
  const isCredits = paymentMode === "credits";

  return cartItems
    .filter((cartItem) => {
      const type = String(cartItem?.product?.type || "")
        .trim()
        .toLowerCase();

      return isOpenStudioCartItem(cartItem);
    })
    .map((cartItem) => {
      const people = getWorkshopPeople(cartItem);
      const locationId = String(cartItem.locationId);
      const dbProduct = productById?.get(String(cartItem?.product?._id));
      const bookingMode = getWorkshopBookingType(cartItem, dbProduct);
      const productCapacity = Number(dbProduct?.maxNumberOfParticipants);

      if (
        dbProduct &&
        dbProduct.bookingMode !== "customer-choice" &&
        (!Number.isSafeInteger(productCapacity) || productCapacity < 1)
      ) {
        badRequest({
          message: "Open Studio does not have a valid participant capacity.",
          code: "OPEN_STUDIO_CAPACITY_NOT_CONFIGURED",
          details: { productId: String(dbProduct?._id || "") },
        });
      }

      if (
        dbProduct &&
        people > productCapacity &&
        dbProduct.bookingMode !== "customer-choice"
      ) {
        conflict({
          message: "The selected product does not allow this many guests.",
          code: "BOOKING_PRODUCT_CAPACITY_EXCEEDED",
          details: {
            productId: String(dbProduct?._id || ""),
            maximum: productCapacity,
            requested: people,
          },
        });
      }

      return {
        participants: [],
        orderedBy: [],
        createdBy: user._id || user,
        createdAt: now,
        orders: orderId ? [orderId] : [],
        start: cartItem.start,
        end: cartItem.end,
        plannedActivity: normalizePlannedActivity(cartItem),
        bookingProduct: cartItem.product._id,
        author: {
          name:
            user.customId === "GUEST"
              ? `${user.firstname || ""} ${user.lastname || ""}`.trim()
              : user.firstname,
          customId: user.customId,
        },
        numberOfHours: getNumberOfHours(cartItem.start, cartItem.end),
        status: isCredits ? BOOKING_STATUS.PROCESSED : BOOKING_STATUS.PENDING,
        paymentStatus: isCredits
          ? PAYMENT_STATUS.CONFIRMED
          : PAYMENT_STATUS.PENDING_PAYMENT,
        paymentExpiresAt: isCredits
          ? undefined
          : paymentExpiresAt ||
            new Date(
              Date.now() +
                (STRIPE_CHECKOUT_SESSION_MINUTES +
                  WORKSHOP_RESERVATION_GRACE_MINUTES) *
                  60 *
                  1000,
            ),
        paymentConfirmedAt: isCredits ? now : undefined,
        tag: cartItem.bookingExtension ? "extension-hold" : BOOKING_TAG.OPEN_STUDIO,
        ...(cartItem.bookingExtension ? {
          extensionFor: cartItem.bookingExtension.bookingId,
          extensionOriginalStart: cartItem.bookingExtension.originalStart,
          extensionQuoteVersion: cartItem.bookingExtension.quoteVersion,
          status: BOOKING_STATUS.PENDING,
          paymentStatus: PAYMENT_STATUS.PENDING_PAYMENT,
          paymentExpiresAt: new Date(Math.min(new Date(cartItem.start).getTime(), new Date(paymentExpiresAt || Date.now() + 35 * 60_000).getTime())),
        } : {}),
        numberOfGuests: people,
        bookingType: bookingMode,
        bookingMode,
        customerChoiceBooking: cartItem.bookingExtension ? Boolean(cartItem.bookingExtension.customerChoiceBooking) : dbProduct?.bookingMode === "customer-choice",
        publicCapacityLimit: cartItem.bookingExtension ? cartItem.bookingExtension.publicCapacityLimit ?? null :
          bookingMode === "public"
            ? resolveProductPublicCapacityLimit(dbProduct)
            : null,
        location: new mongoose.Types.ObjectId(locationId),
        language: cartItem?.language || "cz",
        wasReminderSent: false,
      };
    });
};

/** @deprecated Use buildOpenStudioBookingsToCreate. */
export const buildWorkshopBookingsToCreate = buildOpenStudioBookingsToCreate;

export const buildCourseBookings = (cartItems) => {
  const bookings = cartItems.filter(isClassCartItem).map((cartItem) => {
    const slotId = cartItem.bookingCourse;

    if (!slotId || !mongoose.Types.ObjectId.isValid(String(slotId))) {
      badRequest({
        message: "Every Class checkout item requires a valid Class session.",
        code: "CHECKOUT_BOOKING_REFERENCE_INVALID",
        details: { expectedTag: "course" },
      });
    }

    const productId = cartItem?.product?._id;

    if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
      badRequest({
        message: "Every Class checkout item requires a valid product.",
        code: "CHECKOUT_COURSE_PRODUCT_INVALID",
      });
    }

    const suppliedCounts: Array<{ source: string; value: number }> = [];
    const addNumericCount = (source: string, raw: unknown): void => {
      if (raw === undefined || raw === null || raw === "") return;

      const value = Number(raw);

      if (!Number.isSafeInteger(value) || value <= 0) {
        badRequest({
          message: "Class participant quantity must be a positive integer.",
          code: "CHECKOUT_COURSE_QUANTITY_INVALID",
          details: { source },
        });
      }

      suppliedCounts.push({ source, value });
    };

    addNumericCount("quantity", cartItem.quantity);
    addNumericCount("numberOfGuests", cartItem.numberOfGuests);

    if (cartItem.guests !== undefined && cartItem.guests !== null) {
      if (!Array.isArray(cartItem.guests)) {
        badRequest({
          message: "Class guests must be supplied as a list.",
          code: "CHECKOUT_COURSE_GUESTS_INVALID",
        });
      }

      suppliedCounts.push({
        source: "guests",
        // The authenticated customer is the first participant. `guests`
        // contains only the additional people in the current clients.
        value: cartItem.guests.length + 1,
      });
    }

    const quantity = suppliedCounts[0]?.value ?? 1;
    const mismatch = suppliedCounts.some((count) => count.value !== quantity);

    if (mismatch) {
      badRequest({
        message:
          "Class quantity, participant count and guest list must describe the same number of people.",
        code: "CHECKOUT_COURSE_PARTICIPANT_MISMATCH",
        details: {
          counts: Object.fromEntries(
            suppliedCounts.map(({ source, value }) => [source, value]),
          ),
        },
      });
    }

    if (quantity > MAX_COURSE_PARTICIPANTS_PER_ITEM) {
      badRequest({
        message: "Too many Class participants in one checkout item.",
        code: "CHECKOUT_COURSE_QUANTITY_LIMIT_EXCEEDED",
        details: { maximum: MAX_COURSE_PARTICIPANTS_PER_ITEM },
      });
    }

    return {
      bookingId: new mongoose.Types.ObjectId(String(slotId)),
      productId: new mongoose.Types.ObjectId(String(productId)),
      quantity,
    };
  });

  const totalParticipants = bookings.reduce(
    (total, booking) => total + booking.quantity,
    0,
  );

  if (totalParticipants > MAX_COURSE_PARTICIPANTS_PER_CHECKOUT) {
    badRequest({
      message: "Too many Class participants in one checkout.",
      code: "CHECKOUT_COURSE_CART_LIMIT_EXCEEDED",
      details: { maximum: MAX_COURSE_PARTICIPANTS_PER_CHECKOUT },
    });
  }

  const seenSlotIds = new Set<string>();

  for (const booking of bookings) {
    const slotId = String(booking.bookingId);

    if (seenSlotIds.has(slotId)) {
      badRequest({
        message: "A Class session may only appear once in a checkout.",
        code: "CHECKOUT_COURSE_SLOT_DUPLICATE",
        details: { bookingId: slotId },
      });
    }

    seenSlotIds.add(slotId);
  }

  return bookings;
};

export const buildGuestIncreaseBookings = (cartItems) => {
  const rawOps = cartItems
    .filter(
      (cartItem) => String(cartItem?.product?.type || "") === "guest-increase",
    )
    .map((cartItem) => {
      const bookingId = getGuestIncreaseBookingId(cartItem);
      const addGuests = getAddedGuestsFromCartItem(cartItem);

      if (!mongoose.Types.ObjectId.isValid(String(bookingId))) {
        badRequest({
          message:
            "Every guest-increase checkout item requires a valid Open Studio booking.",
          code: "CHECKOUT_BOOKING_REFERENCE_INVALID",
          details: { expectedTag: "workshop" },
        });
      }
      if (!Number.isFinite(addGuests) || addGuests <= 0) {
        badRequest({
          message: "The guest increase must be a positive number.",
          code: "CHECKOUT_GUEST_INCREASE_INVALID",
        });
      }

      if (
        !Number.isSafeInteger(addGuests) ||
        addGuests > MAX_GUEST_INCREASE_PER_ITEM
      ) {
        badRequest({
          message: "The guest increase quantity is too large.",
          code: "CHECKOUT_GUEST_INCREASE_LIMIT_EXCEEDED",
          details: { maximum: MAX_GUEST_INCREASE_PER_ITEM },
        });
      }

      const billingBlocks = Number(cartItem.quantity ?? 1);

      if (
        !Number.isSafeInteger(billingBlocks) ||
        billingBlocks < 1 ||
        billingBlocks > MAX_GUEST_INCREASE_BLOCKS
      ) {
        badRequest({
          message: "The guest increase billing duration is invalid.",
          code: "CHECKOUT_GUEST_INCREASE_DURATION_INVALID",
        });
      }

      const productId = cartItem?.product?._id;

      if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
        badRequest({
          message: "The guest increase product is invalid.",
          code: "CHECKOUT_GUEST_INCREASE_PRODUCT_INVALID",
        });
      }

      return {
        bookingId: new mongoose.Types.ObjectId(String(bookingId)),
        productId: new mongoose.Types.ObjectId(String(productId)),
        addGuests,
        billingBlocks,
      };
    });

  const seenBookingIds = new Set<string>();

  for (const op of rawOps) {
    const bookingId = String(op.bookingId);

    if (seenBookingIds.has(bookingId)) {
      badRequest({
        message:
          "An Open Studio guest increase may only appear once in a checkout.",
        code: "CHECKOUT_GUEST_INCREASE_DUPLICATE",
        details: { bookingId },
      });
    }

    seenBookingIds.add(bookingId);
  }

  return rawOps;
};

/**
 * Standalone service products intentionally have no booking fulfillment.
 * Their durable order and invoice are the work record. This is also the
 * minimal checkout path used by standalone, non-booking services.
 */
export const hasStandaloneServiceItems = (cartItems) =>
  cartItems.some((cartItem) => {
    const isService =
      String(cartItem?.product?.type || "")
        .trim()
        .toLowerCase() === "service";

    return isService && !cartItem?.start && !cartItem?.end;
  });
