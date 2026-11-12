import { assertStudioProductLocation } from "@/modules/product/product-location.policy.js";

type ImportedBooking = {
  productId?: string;
  locationId?: string;
  status: string;
  end: string;
};

type ExistingBooking = {
  bookingProduct?: unknown;
  location?: unknown;
  status?: unknown;
  end?: unknown;
};

const isHistorical = (status: unknown, end: unknown): boolean =>
  ["completed", "cancelled", "delivered"].includes(String(status)) ||
  new Date(String(end)).getTime() <= Date.now();

/** Historical source records and unchanged reservations retain purchased terms. */
export const assertImportedBookingProductLocation = ({
  product,
  booking,
  existing,
}: {
  product: { type?: unknown; kind?: unknown; location?: unknown };
  booking: ImportedBooking;
  existing?: ExistingBooking | null;
}): void => {
  if (isHistorical(booking.status, booking.end)) return;
  if (
    existing &&
    !isHistorical(existing.status, existing.end) &&
    String(existing.bookingProduct) === booking.productId &&
    String(existing.location) === booking.locationId
  ) return;

  assertStudioProductLocation(product, booking.locationId);
};
