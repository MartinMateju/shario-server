import { createHash } from "node:crypto";

import { DEFAULT_TIMEZONE } from "@/modules/location/location.constants.js";
import { resolveLocationActivitySelectionMode } from "@/modules/location/location.utils.js";
import {
  resolveOpenStudioPolicy,
  resolveProductKindV2,
  resolveProductOpenStudioBookingModeV2,
} from "@/modules/product/product.utils.js";

type PracticeConfiguration = { product: any; location: any };
const hash = (configuration: unknown) =>
  createHash("sha256").update(JSON.stringify(configuration)).digest("hex");

// Only used to recognize and upgrade evidence created before semantic hashes.
export const legacyPracticeFingerprint = ({
  product,
  location,
}: PracticeConfiguration): string => {
  if (!product || !location) return "";
  return hash({
    productId: String(product._id),
    productUpdatedAt: product.updatedAt,
    productActive: product.isActive,
    price: product.price,
    currency: product.currency,
    capacity: product.maxNumberOfParticipants,
    locationId: String(location._id),
    locationUpdatedAt: location.updatedAt,
    locationActive: location.isActive,
    bookingEnabled: location.booking?.enabled,
  });
};

const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export const practiceFingerprint = ({
  product,
  location,
}: PracticeConfiguration): string => {
  if (!product || !location) return "";
  const booking = location.booking ?? {};
  const bookingMode = resolveProductOpenStudioBookingModeV2(product);

  // updatedAt and capacityRevision change during ordinary bookings. They are
  // not configuration changes and must not invalidate an owner's review.
  return hash({
    version: 2,
    product: {
      id: String(product._id),
      locationId: product.location ? String(product.location) : null,
      active: product.isActive === true,
      kind: resolveProductKindV2(product),
      bookingMode,
      price: Number(product.price),
      extraCharge: Number(product.extraCharge ?? 0),
      currency: String(product.currency ?? "")
        .trim()
        .toUpperCase(),
      capacity: Number(product.maxNumberOfParticipants),
      openStudioPolicy:
        bookingMode === "customer-choice"
          ? resolveOpenStudioPolicy(product.openStudioPolicy)
          : null,
    },
    location: {
      id: String(location._id),
      active: location.isActive === true,
      booking: {
        enabled: booking.enabled === true,
        timezone: String(booking.timezone ?? "").trim() || DEFAULT_TIMEZONE,
        slotStepMinutes: Math.max(15, Number(booking.slotStepMinutes ?? 30)),
        minBookingMinutes: Math.max(
          15,
          Number(booking.minBookingMinutes ?? 60),
        ),
        maxBookingMinutes: Math.max(
          15,
          Number(booking.maxBookingMinutes ?? 360),
        ),
        globalCapacity: Math.max(
          1,
          Math.floor(Number(booking.globalCapacity) || 1),
        ),
        allowPublicOverlap: Boolean(
          booking.allowPublicOverlap ?? booking.allowPublicSoloOverlap === true,
        ),
        maxPublicOverlaps: Math.max(
          1,
          Number(
            booking.maxConcurrentOpenStudioBookings ??
              booking.maxPublicOverlaps ??
              booking.maxPublicSoloOverlaps,
          ) || 1,
        ),
        privateSessionBlocksAll: booking.privateSessionBlocksAll !== false,
        groupBookingBlocksAll: booking.groupBookingBlocksAll !== false,
        activitySelectionMode: resolveLocationActivitySelectionMode(
          booking.activitySelectionMode,
        ),
        activityCapacities: (booking.activityCapacities ?? [])
          .map((entry: any) => ({
            activity: String(entry?.activity ?? "").trim(),
            capacity: Math.max(1, Math.floor(Number(entry?.capacity) || 1)),
          }))
          .filter((entry: { activity: string }) => Boolean(entry.activity))
          .sort(
            (
              a: { activity: string; capacity: number },
              b: { activity: string; capacity: number },
            ) =>
              a.activity.localeCompare(b.activity) || a.capacity - b.capacity,
          ),
      },
      openingHours: weekdays.map((day) => {
        const hours = location.openingHours?.[day];
        return hours?.isOpen
          ? {
              day,
              isOpen: true,
              openTime: hours.openTime,
              closeTime: hours.closeTime,
            }
          : { day, isOpen: false };
      }),
    },
  });
};
