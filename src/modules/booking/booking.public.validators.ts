import { z } from "zod";

import { PLANNED_ACTIVITY } from "./booking.constants.js";

const objectId = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{24}$/i, "Enter a valid identifier.");

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OCCUPANCY_MAX_DAYS = 14;

const dateOnlyOrdinal = (value: string): number | null => {
  if (!DATE_ONLY_PATTERN.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(timestamp / (24 * 60 * 60 * 1_000));
};

const publicDate = z
  .string()
  .trim()
  .refine(
    (value) => dateOnlyOrdinal(value) !== null,
    "Enter a valid date as YYYY-MM-DD.",
  );

export const publicBookingAvailabilityQuerySchema = z
  .object({
    locationId: objectId,
    productId: objectId,
    bookingMode: z.enum(["public", "private"]).optional(),
    numberOfGuests: z.coerce.number().int().min(1).max(100).optional(),
    date: publicDate,
    plannedActivity: z
      .enum([
        PLANNED_ACTIVITY.WORKSTATION,
        PLANNED_ACTIVITY.SHARED_TABLE,
        PLANNED_ACTIVITY.UNDEFINED,
      ])
      .optional(),
  })
  .strict();

export const publicBookingOccupancyQuerySchema = z
  .object({
    locationId: objectId,
    from: publicDate,
    to: publicDate,
  })
  .strict()
  .superRefine(({ from, to }, ctx) => {
    const fromDay = dateOnlyOrdinal(from);
    const toDay = dateOnlyOrdinal(to);

    if (fromDay === null || toDay === null) return;

    if (toDay < fromDay) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "The occupancy end date must not be before the start date.",
      });
      return;
    }

    if (toDay - fromDay + 1 > OCCUPANCY_MAX_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `Occupancy may be requested for at most ${OCCUPANCY_MAX_DAYS} days.`,
      });
    }
  });
