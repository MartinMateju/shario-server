import {
  DEFAULT_STUDIO_COMMERCE_CURRENCY,
  fromCurrencyMinorUnits,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";

type BookingPricingInput = {
  bookingProduct?: {
    price?: number;
    name?: string;
  } | null;
  numberOfHours?: number | { toString: () => string } | null;
  numberOfGuests?: number | null;
  currency?: StudioCommerceCurrency;
};

const decimalToNumber = (value: BookingPricingInput["numberOfHours"]): number => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
};

export const calculateWorkshopRefundAmount = (booking: BookingPricingInput) => {
  const productPrice = Number(booking.bookingProduct?.price) || 0;
  const numberOfHours = decimalToNumber(booking.numberOfHours);
  const participants = Math.max(1, Number(booking.numberOfGuests) || 1);
  const currency = booking.currency ?? DEFAULT_STUDIO_COMMERCE_CURRENCY;

  const baseAmount = productPrice * numberOfHours * participants;
  const refundAmount = fromCurrencyMinorUnits(
    toCurrencyMinorUnits(Math.max(0, baseAmount), currency),
    currency,
  );

  return {
    productPrice,
    numberOfHours,
    participants,
    baseAmount,
    refundAmount,
    currency,
  };
};
