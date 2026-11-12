import { badRequest } from "@/shared/http/httpErrors.js";
import {
  isCustomerChoiceOpenStudioProduct,
  resolveProductPrivateBookingSurcharge,
} from "@/modules/product/product.utils.js";
import {
  normalizeCurrency,
  normalizePrice,
  toMinorUnits,
  safeQty,
  assertStripeMinimum,
} from "@/infrastructure/payments/stripe-pricing.js";
import {
  normalizeStudioCommerceCurrency,
  fromCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

import {
  getCartItemBillableUnits,
  getCartItemNumberOfPeople,
  getWorkshopBookingType,
  getWorkshopPeople,
} from "../checkout.utils.js";
import { buildCourseBookings } from "./checkout.cart.service.js";

const buildCourseQuantityByProductAndSlot = (cartItems = []) => {
  const quantityByIdentity = new Map<string, number>();

  for (const booking of buildCourseBookings(cartItems)) {
    quantityByIdentity.set(
      `${String(booking.productId)}:${String(booking.bookingId)}`,
      booking.quantity,
    );
  }

  return quantityByIdentity;
};

const getServerBillableUnits = ({
  cartItem,
  dbProduct,
  courseQuantityByIdentity,
}) => {
  const type = String(dbProduct?.type || "").toLowerCase();
  const kind = String(dbProduct?.kind || "").toLowerCase();

  if (kind === "class" || type.includes("course")) {
    const identity = `${String(dbProduct._id)}:${String(
      cartItem?.bookingCourse || "",
    )}`;
    const quantity = courseQuantityByIdentity.get(identity);

    if (!quantity) {
      badRequest({
        message: "Course participant quantity could not be resolved.",
        code: "CHECKOUT_COURSE_QUANTITY_INVALID",
      });
    }

    return quantity;
  }

  return safeQty(getCartItemBillableUnits(cartItem, type));
};

const getCartItemProductId = (cartItem) => {
  const productId = cartItem?.product?._id ?? cartItem?.product;

  if (!productId) {
    badRequest({
      message: "Cart item is missing product.",
      code: "CART_ITEM_PRODUCT_MISSING",
    });
  }

  return String(productId);
};

const getProductFromMap = (productById, cartItem) => {
  const productId = getCartItemProductId(cartItem);
  const dbProduct = productById.get(productId);

  if (!dbProduct) {
    badRequest({
      message: "Product in cart was not found.",
      code: "CART_PRODUCT_NOT_FOUND",
      details: { productId },
    });
  }

  return dbProduct;
};

export const resolveServerCheckoutCurrency = ({
  products,
  tenantCurrency,
  requestedCurrency,
}: {
  products: Array<{ currency?: unknown }>;
  tenantCurrency: unknown;
  requestedCurrency?: unknown;
}): SupportedCheckoutCurrency => {
  let operationalCurrency: StudioCommerceCurrency;

  try {
    operationalCurrency = normalizeStudioCommerceCurrency(tenantCurrency);
  } catch {
    badRequest({
      message: "The workspace currency is not supported.",
      code: "TENANT_CURRENCY_UNSUPPORTED",
    });
  }

  const currencies = new Set<StudioCommerceCurrency>();

  for (const product of products) {
    try {
      currencies.add(normalizeStudioCommerceCurrency(product.currency));
    } catch {
      badRequest({
        message: "A product has an unsupported currency.",
        code: "PRODUCT_CURRENCY_UNSUPPORTED",
      });
    }
  }

  if (currencies.size !== 1) {
    badRequest({
      message: "All products in a cart must use the same currency.",
      code: "MIXED_CART_CURRENCIES",
    });
  }

  const [productCurrency] = currencies;

  if (productCurrency !== operationalCurrency) {
    badRequest({
      message: "Product currency does not match the workspace currency.",
      code: "TENANT_PRODUCT_CURRENCY_MISMATCH",
      details: {
        tenantCurrency: operationalCurrency,
        productCurrency,
      },
    });
  }

  if (requestedCurrency !== undefined && requestedCurrency !== null) {
    let normalizedRequested: StudioCommerceCurrency;

    try {
      normalizedRequested = normalizeStudioCommerceCurrency(requestedCurrency);
    } catch {
      badRequest({
        message: "The requested checkout currency is not supported.",
        code: "CHECKOUT_CURRENCY_UNSUPPORTED",
      });
    }

    if (normalizedRequested !== productCurrency) {
      badRequest({
        message: "Checkout currency must match the product currency.",
        code: "CHECKOUT_CURRENCY_MISMATCH",
      });
    }
  }

  return productCurrency.toLowerCase() as SupportedCheckoutCurrency;
};

type SupportedCheckoutCurrency = ReturnType<typeof normalizeCurrency>;

export const getBookingExtraChargeMajor = (cartItem, dbProduct) => {
  const type = String(dbProduct?.type || "").toLowerCase();
  const kind = String(dbProduct?.kind || "").toLowerCase();

  if (kind !== "open-studio" && !type.includes("workshop")) return 0;

  // Customer-choice privacy is priced once for the entire reservation below.
  if (isCustomerChoiceOpenStudioProduct(dbProduct)) return 0;

  const people = getWorkshopPeople(cartItem);
  const bookingType = getWorkshopBookingType(cartItem, dbProduct);

  if (people !== 1 || bookingType !== "private") return 0;

  const extra = normalizePrice(dbProduct?.extraCharge || 0);

  return Number.isFinite(extra) ? extra : 0;
};

export const buildServerPricedCartItems = ({ cartItems = [], productById }) => {
  if (!productById) {
    badRequest({
      message: "Product map is required for checkout pricing.",
      code: "CHECKOUT_PRODUCT_MAP_MISSING",
    });
  }

  const courseQuantityByIdentity =
    buildCourseQuantityByProductAndSlot(cartItems);

  return cartItems.map((cartItem) => {
    const dbProduct = getProductFromMap(productById, cartItem);
    const type = String(dbProduct.type || "").toLowerCase();
    if (cartItem.bookingExtension) {
      const amount = fromCurrencyMinorUnits(cartItem.bookingExtension.amountMinor, normalizeStudioCommerceCurrency(dbProduct.currency));
      return { product: dbProduct._id, quantity: 1, basePrice: amount, extraCharge: 0, totalPrice: amount, numberOfPeople: getCartItemNumberOfPeople(cartItem, type) };
    }

    const billableUnits = getServerBillableUnits({
      cartItem,
      dbProduct,
      courseQuantityByIdentity,
    });

    const baseUnitMajor = normalizePrice(dbProduct.price);

    if (!Number.isFinite(baseUnitMajor) || baseUnitMajor < 0) {
      badRequest({
        message: "Product has an invalid price.",
        code: "INVALID_PRODUCT_PRICE",
        details: {
          productId: String(dbProduct._id),
          price: dbProduct.price,
        },
      });
    }

    const bookingExtraCharge = getBookingExtraChargeMajor(cartItem, dbProduct);

    const isPrivateChoice =
      isCustomerChoiceOpenStudioProduct(dbProduct) &&
      getWorkshopBookingType(cartItem, dbProduct) === "private";

    // Represent the complete private reservation as one invoice/Stripe unit.
    // Spreading a flat fee over person-hours introduces currency rounding and
    // would allow quantity changes to multiply the surcharge.
    const quantity = isPrivateChoice ? 1 : billableUnits;
    const basePrice = isPrivateChoice
      ? baseUnitMajor * billableUnits
      : baseUnitMajor;
    const extraCharge = isPrivateChoice
      ? resolveProductPrivateBookingSurcharge(dbProduct)
      : bookingExtraCharge;

    return {
      product: dbProduct._id,
      quantity,
      basePrice,
      extraCharge,
      totalPrice: (basePrice + extraCharge) * quantity,
      numberOfPeople: getCartItemNumberOfPeople(cartItem, type),
    };
  });
};

export const getCartTotalMajor = (mappedCartItems = []) =>
  mappedCartItems.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);

const getProductName = (dbProduct) => {
  if (typeof dbProduct.name === "object" && dbProduct.name) {
    return dbProduct.name.CZ || dbProduct.name.EN || "Item";
  }

  return String(dbProduct.name || "Item");
};

export const buildStripeLineItems = ({
  cartItems = [],
  productById,
  currency,
}) => {
  if (!productById) {
    badRequest({
      message: "Product map is required for Stripe checkout.",
      code: "CHECKOUT_PRODUCT_MAP_MISSING",
    });
  }

  const normalizedCurrency = normalizeCurrency(currency);
  const lineItems = [];
  const courseQuantityByIdentity =
    buildCourseQuantityByProductAndSlot(cartItems);

  for (const cartItem of cartItems) {
    const dbProduct = getProductFromMap(productById, cartItem);
    if (cartItem.bookingExtension) {
      lineItems.push({ quantity: 1, price_data: { currency: normalizedCurrency, unit_amount: cartItem.bookingExtension.amountMinor, product_data: { name: `${getProductName(dbProduct)} — extension` } } });
      continue;
    }
    const type = String(dbProduct.type || "").toLowerCase();

    const billableUnits = getServerBillableUnits({
      cartItem,
      dbProduct,
      courseQuantityByIdentity,
    });

    const baseUnitMajor = normalizePrice(dbProduct.price);

    if (!Number.isFinite(baseUnitMajor) || baseUnitMajor < 0) {
      badRequest({
        message: "Product has an invalid price.",
        code: "INVALID_PRODUCT_PRICE",
        details: {
          productId: String(dbProduct._id),
          price: dbProduct.price,
        },
      });
    }

    const bookingExtraCharge = getBookingExtraChargeMajor(cartItem, dbProduct);

    const isPrivateChoice =
      isCustomerChoiceOpenStudioProduct(dbProduct) &&
      getWorkshopBookingType(cartItem, dbProduct) === "private";
    const quantity = isPrivateChoice ? 1 : billableUnits;
    const privateSurcharge = isPrivateChoice
      ? resolveProductPrivateBookingSurcharge(dbProduct)
      : 0;
    const unitMajor = isPrivateChoice
      ? baseUnitMajor * billableUnits + privateSurcharge
      : baseUnitMajor + bookingExtraCharge;
    const unitAmount = toMinorUnits(unitMajor, normalizedCurrency);

    if (unitAmount <= 0 || quantity <= 0) {
      continue;
    }

    const name = getProductName(dbProduct);

    lineItems.push({
      quantity,
      price_data: {
        currency: normalizedCurrency,
        unit_amount: unitAmount,
        product_data: {
          name: String(name).trim() || "Item",
          description: dbProduct.description || undefined,
          metadata: {
            productId: String(dbProduct._id),
            type: String(dbProduct.type || ""),
            bookingExtraChargeMajor: String(bookingExtraCharge),
            ...(isPrivateChoice
              ? { privateBookingSurchargeMajor: String(privateSurcharge) }
              : {}),
          },
        },
      },
    });
  }

  if (lineItems.length === 0) {
    badRequest({
      message: "Checkout cart does not contain any billable items.",
      code: "CHECKOUT_EMPTY_LINE_ITEMS",
    });
  }

  const minCheck = assertStripeMinimum(lineItems, normalizedCurrency);

  return {
    currency: normalizedCurrency,
    lineItems,
    minCheck,
    totalMinor: lineItems.reduce(
      (sum, item) =>
        sum +
        Number(item.price_data.unit_amount || 0) * Number(item.quantity || 0),
      0,
    ),
  };
};

/**
 * Reprices Stripe Checkout from the already-discounted, invoice-safe order
 * lines. Keeping one server-priced order line per Stripe line means the
 * provider amount, fulfillment amount and accounting snapshot cannot drift.
 */
export const applyOrderLinePricesToStripePayload = ({
  stripePayload,
  orderLineItems,
}) => {
  if (orderLineItems.some((line, index) => !stripePayload.lineItems[line.sourceLineIndex ?? index])) {
    badRequest({
      message: "Discounted order lines do not match Stripe checkout lines.",
      code: "CHECKOUT_DISCOUNT_LINE_MISMATCH",
    });
  }

  const lineItems = orderLineItems.map((orderLine, index) => {
    const lineItem = stripePayload.lineItems[orderLine.sourceLineIndex ?? index];
    const unitAmount = Number(orderLine.unitGrossMinor);

    if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) {
      badRequest({
        message:
          "A membership discount reduced an item to zero. Free-order checkout is not supported yet.",
        code: "CHECKOUT_ZERO_TOTAL_DISCOUNT_UNSUPPORTED",
      });
    }

    return {
      ...lineItem,
      quantity: Number(orderLine.quantity),
      price_data: {
        ...lineItem.price_data,
        unit_amount: unitAmount,
      },
    };
  });

  const minCheck = assertStripeMinimum(lineItems, stripePayload.currency);

  return {
    ...stripePayload,
    lineItems,
    minCheck,
    totalMinor: minCheck.totalMinor,
  };
};

export const calculateCreditsDiscount = ({
  requestedCreditsMajor = 0,
  totalMinor,
  currency,
}) => {
  const normalizedCurrency = normalizeCurrency(currency);

  const safeTotalMinor = Number(totalMinor);

  if (!Number.isSafeInteger(safeTotalMinor) || safeTotalMinor < 0) {
    badRequest({
      message: "Checkout total must be a nonnegative minor-unit integer.",
      code: "INVALID_CHECKOUT_TOTAL_MINOR",
      details: { totalMinor },
    });
  }

  const requestedMajor = Math.max(0, Number(requestedCreditsMajor) || 0);
  let requestedMinor: number;

  try {
    requestedMinor = toMinorUnits(requestedMajor, normalizedCurrency);
  } catch {
    badRequest({
      message: "Credits amount has invalid currency precision.",
      code: "INVALID_CREDITS_PRECISION",
    });
  }

  const appliedMinor =
    requestedMajor > 0
      ? Math.max(0, Math.min(requestedMinor, safeTotalMinor))
      : 0;

  return {
    requestedMajor,
    appliedMinor,
    appliedMajor: fromCurrencyMinorUnits(
      appliedMinor,
      normalizedCurrency.toUpperCase() as StudioCommerceCurrency,
    ),
  };
};

export const assertStripePayableAmountAfterCredits = ({
  expectedAmountMinor,
  appliedCreditsMinor,
  minimumAmountMinor,
  currency,
}: {
  expectedAmountMinor: number;
  appliedCreditsMinor: number;
  minimumAmountMinor: number | null;
  currency: string;
}): void => {
  if (
    !Number.isSafeInteger(expectedAmountMinor) ||
    expectedAmountMinor < 0 ||
    !Number.isSafeInteger(appliedCreditsMinor) ||
    appliedCreditsMinor < 0
  ) {
    badRequest({
      message: "The checkout payable amount is invalid.",
      code: "INVALID_CHECKOUT_TOTAL_MINOR",
    });
  }

  if (appliedCreditsMinor > 0 && expectedAmountMinor === 0) {
    badRequest({
      message:
        "Credits cover the full order. Complete this order using the credits checkout instead.",
      code: "USE_CREDITS_CHECKOUT",
      details: { endpoint: "/checkout/credits", currency },
    });
  }

  if (
    expectedAmountMinor > 0 &&
    minimumAmountMinor !== null &&
    expectedAmountMinor < minimumAmountMinor
  ) {
    badRequest({
      message:
        "The amount remaining after credits is below Stripe's minimum charge. Apply fewer credits or use the credits checkout when credits cover the full order.",
      code: "STRIPE_MINIMUM_AFTER_CREDITS",
      details: {
        endpoint: "/checkout/credits",
        currency,
        expectedAmountMinor,
        minimumAmountMinor,
      },
    });
  }
};
