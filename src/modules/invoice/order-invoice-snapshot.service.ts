import mongoose from "mongoose";

import {
  CLASS_BOOKING_TAGS,
  OPEN_STUDIO_BOOKING_TAGS,
} from "@/modules/booking/booking.constants.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import {
  assertMinorAmount,
  assertTaxRateBps,
  calculateInclusiveTax,
  majorToMinor,
} from "./invoice.money.js";
import {
  INVOICE_PAYMENT_METHOD,
  type InvoicePaymentMethod,
} from "./invoice.constants.js";

const ORDER_INVOICE_PAYMENT_METHODS = new Set<InvoicePaymentMethod>([
  INVOICE_PAYMENT_METHOD.STRIPE,
  INVOICE_PAYMENT_METHOD.CREDITS,
  INVOICE_PAYMENT_METHOD.VOUCHER,
  INVOICE_PAYMENT_METHOD.MANUAL,
]);

const uniqueObjectIds = (values: readonly unknown[]) =>
  [...new Set(values.map(String).filter(mongoose.isValidObjectId))].map(
    (value) => new mongoose.Types.ObjectId(value),
  );

const isMinorAmount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Determines whether a legacy order contains an accounting snapshot that can
 * safely be used to issue an invoice. Net and tax are derived from the stored
 * tax-inclusive gross amount and integer basis-point rate; merely adding up to
 * gross is not sufficient evidence that the snapshot is trustworthy.
 */
export const hasTrustedOrderInvoiceSnapshot = (order: any): boolean => {
  if (!Array.isArray(order?.lineItems) || order.lineItems.length === 0) {
    return false;
  }
  if (!isMinorAmount(order.grossAmountMinor)) return false;

  let grossTotal = 0;
  for (const line of order.lineItems) {
    const quantity = line.quantity;
    const unitGrossMinor = line.unitGrossMinor;
    const grossAmountMinor = line.grossAmountMinor;
    const netAmountMinor = line.netAmountMinor;
    const taxAmountMinor = line.taxAmountMinor;
    const taxRateBps = line.taxRateBps;

    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      ![unitGrossMinor, grossAmountMinor, netAmountMinor, taxAmountMinor].every(
        isMinorAmount,
      ) ||
      !Number.isSafeInteger(taxRateBps) ||
      taxRateBps < 0 ||
      taxRateBps > 10000 ||
      !Number.isSafeInteger(unitGrossMinor * quantity) ||
      unitGrossMinor * quantity !== grossAmountMinor
    ) {
      return false;
    }

    let expectedTax: ReturnType<typeof calculateInclusiveTax>;
    try {
      expectedTax = calculateInclusiveTax({ grossAmountMinor, taxRateBps });
    } catch {
      return false;
    }
    if (
      netAmountMinor !== expectedTax.netAmountMinor ||
      taxAmountMinor !== expectedTax.taxAmountMinor
    ) {
      return false;
    }

    grossTotal += grossAmountMinor;
    if (!Number.isSafeInteger(grossTotal)) return false;
  }
  if (grossTotal !== order.grossAmountMinor) return false;

  if (order.isPaid) {
    if (!Array.isArray(order.paymentAllocations)) return false;
    if (
      order.paymentAllocations.some(
        (allocation: any) => !isMinorAmount(allocation.amountMinor),
      )
    ) {
      return false;
    }
    const allocated = order.paymentAllocations.reduce(
      (sum: number, allocation: any) =>
        sum + allocation.amountMinor,
      0,
    );
    if (!Number.isSafeInteger(allocated) || allocated !== grossTotal) {
      return false;
    }
  }

  return true;
};

export const assertReferencedBookingContexts = ({
  courseBookingIds,
  guestIncreaseBookingIds,
  contexts,
}: {
  courseBookingIds: readonly unknown[];
  guestIncreaseBookingIds: readonly unknown[];
  contexts: Array<{ _id?: unknown; tag?: unknown; location?: unknown }>;
}): Map<string, unknown> => {
  const courseIds = new Set(courseBookingIds.map(String));
  const guestIds = new Set(guestIncreaseBookingIds.map(String));
  const expectedIds = new Set([...courseIds, ...guestIds]);
  const conflictingId = [...courseIds].find((id) => guestIds.has(id));
  if (conflictingId) {
    badRequest({
      message: "A booking cannot be both a course and a guest-increase target.",
      code: "CHECKOUT_BOOKING_REFERENCE_CONFLICT",
      details: { bookingId: conflictingId },
    });
  }
  const contextById = new Map(
    contexts.map((context) => [String(context._id ?? ""), context]),
  );

  for (const id of expectedIds) {
    const context = contextById.get(id);
    const expectedTag = courseIds.has(id) ? "course" : "workshop";
    const expectedTags: readonly string[] = courseIds.has(id)
      ? CLASS_BOOKING_TAGS
      : OPEN_STUDIO_BOOKING_TAGS;
    if (
      !context ||
      !expectedTags.includes(String(context.tag || "").toLowerCase()) ||
      !mongoose.isValidObjectId(String(context.location ?? ""))
    ) {
      badRequest({
        message: "A referenced booking is missing, has the wrong type, or has no location.",
        code: "CHECKOUT_BOOKING_REFERENCE_INVALID",
        details: { bookingId: id, expectedTag },
      });
    }
  }

  return new Map(
    [...expectedIds].map((id) => [id, contextById.get(id)?.location]),
  );
};

const getProductName = (product: any): string => {
  if (product?.name && typeof product.name === "object") {
    return String(product.name.CZ || product.name.EN || "Item");
  }
  return String(product?.name || "Item");
};

export const buildOrderLineSnapshots = ({
  sourceCartItems,
  pricedCartItems,
  productById,
  currency: rawCurrency,
  defaultTaxRateBps,
  pricesIncludeTax,
  relatedLocationByBookingId = new Map<string, unknown>(),
}: {
  sourceCartItems: any[];
  pricedCartItems: any[];
  productById: Map<string, any>;
  currency: unknown;
  defaultTaxRateBps: number;
  pricesIncludeTax: boolean;
  relatedLocationByBookingId?: Map<string, unknown>;
}) => {
  let currency: ReturnType<typeof normalizeStudioCommerceCurrency>;
  try {
    currency = normalizeStudioCommerceCurrency(rawCurrency);
  } catch {
    badRequest("Order currency is not supported.");
  }

  const configuredTaxRateBps = assertTaxRateBps(defaultTaxRateBps);

  if (!pricesIncludeTax && configuredTaxRateBps > 0) {
    badRequest({
      message:
        "Tax-exclusive checkout pricing is not enabled. Configure tax-inclusive product prices or set the invoice tax rate to zero.",
      code: "EXCLUSIVE_TAX_NOT_SUPPORTED",
    });
  }

  if (sourceCartItems.length !== pricedCartItems.length) {
    badRequest("Order line snapshots do not match the priced cart.");
  }

  return pricedCartItems.map((pricedItem, index) => {
    const source = sourceCartItems[index] ?? {};
    const productId = String(pricedItem.product ?? source.product?._id ?? "");
    const product = productById.get(productId);
    const quantity = Math.max(1, Math.floor(Number(pricedItem.quantity) || 1));
    const unitGrossMinor = majorToMinor(
      Number(pricedItem.basePrice || 0) + Number(pricedItem.extraCharge || 0),
      currency,
    );
    const grossAmountMinor = unitGrossMinor * quantity;
    const taxRateBps = pricesIncludeTax ? configuredTaxRateBps : 0;
    const tax = calculateInclusiveTax({ grossAmountMinor, taxRateBps });
    const bookingId =
      source.bookingCourse ??
      source.bookingWorkshop ??
      source.bookingRef ??
      source.bookingId ??
      source.booking;
    // An existing course/booking belongs to its persisted location. Never add
    // a cart-supplied location to that scope: it could make an out-of-scope
    // course eligible for a membership or location-restricted voucher.
    const locationIds = uniqueObjectIds([
      bookingId
        ? relatedLocationByBookingId.get(String(bookingId))
        : source.locationId,
    ]);

    return {
      product: mongoose.isValidObjectId(productId)
        ? new mongoose.Types.ObjectId(productId)
        : null,
      booking: mongoose.isValidObjectId(String(bookingId ?? ""))
        ? new mongoose.Types.ObjectId(String(bookingId))
        : null,
      description: getProductName(product),
      sku: String(product?.sku || ""),
      quantity,
      unitGrossMinor,
      grossAmountMinor,
      netAmountMinor: tax.netAmountMinor,
      taxAmountMinor: tax.taxAmountMinor,
      taxRateBps,
      locationIds,
    };
  });
};

export const collectOrderLocationIds = (lines: Array<{ locationIds?: unknown[] }>) =>
  uniqueObjectIds(lines.flatMap((line) => line.locationIds ?? []));

const createsWorkshopBooking = (source: Record<string, any>): boolean => {
  const type = String(source?.product?.type || "")
    .trim()
    .toLowerCase();

  return (
    type.includes("workshop") ||
    (type === "service" && Boolean(source?.start) && Boolean(source?.end))
  );
};

/**
 * Workshop bookings are created only after the immutable invoice snapshot has
 * been priced. Link the returned booking IDs back to their corresponding
 * order lines before the order is saved, preserving cart/insert order.
 */
export const attachWorkshopBookingsToOrderLines = <
  Line extends Record<string, any>,
>({
  sourceCartItems,
  lineItems,
  bookingIds,
}: {
  sourceCartItems: Array<Record<string, any>>;
  lineItems: Line[];
  bookingIds: unknown[];
}): Line[] => {
  if (new Set(lineItems.map((line, index) => line.sourceLineIndex ?? index)).size !== sourceCartItems.length) {
    throw new Error("Workshop booking lines do not match the checkout cart.");
  }

  let bookingIndex = 0;
  const linkedBySourceIndex = new Map<number, unknown>();
  const linkedLines = lineItems.map((line, index) => {
    const sourceIndex = line.sourceLineIndex ?? index;
    if (linkedBySourceIndex.has(sourceIndex)) return { ...line, booking: linkedBySourceIndex.get(sourceIndex) };
    if (sourceCartItems[sourceIndex]?.bookingExtension) {
      bookingIndex += 1;
      const booking = new mongoose.Types.ObjectId(String(sourceCartItems[sourceIndex].bookingExtension.bookingId));
      linkedBySourceIndex.set(sourceIndex, booking);
      return { ...line, booking };
    }
    if (!createsWorkshopBooking(sourceCartItems[sourceIndex] || {})) return line;

    const bookingId = bookingIds[bookingIndex];
    bookingIndex += 1;

    if (!mongoose.isValidObjectId(bookingId)) {
      throw new Error("A workshop order line is missing its booking ID.");
    }

    linkedBySourceIndex.set(sourceIndex, new mongoose.Types.ObjectId(String(bookingId)));
    return {
      ...line,
      booking: new mongoose.Types.ObjectId(String(bookingId)),
    };
  });

  if (bookingIndex !== bookingIds.length) {
    throw new Error("Workshop booking IDs do not match the checkout cart.");
  }

  return linkedLines;
};

export const buildOrderInvoicePaymentAllocations = ({
  orderId,
  allocations,
  paidAt,
}: {
  orderId: unknown;
  allocations: Array<{
    method?: unknown;
    amountMinor?: unknown;
    providerReference?: unknown;
  }>;
  paidAt?: Date | string | null;
}) => {
  const paymentDate = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(paymentDate.getTime())) {
    badRequest("Paid order has an invalid payment date.");
  }

  return allocations.map((allocation, index) => {
    const method = String(allocation.method || "") as InvoicePaymentMethod;
    if (!ORDER_INVOICE_PAYMENT_METHODS.has(method)) {
      badRequest("Paid order contains an unsupported payment method.");
    }
    const amountMinor = assertMinorAmount(
      allocation.amountMinor,
      "Payment allocation",
    );
    const providerReference = String(allocation.providerReference || "");

    return {
      method,
      amountMinor,
      providerReference,
      idempotencyKey: `order:${String(orderId)}:${method}:${
        providerReference || index
      }`,
      paidAt: paymentDate,
      recordedAt: paymentDate,
      recordedBy: null,
      reversedAt: null,
      reversedBy: null,
      reversalReason: "",
      reversalIdempotencyKey: "",
    };
  });
};
