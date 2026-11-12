import mongoose from "mongoose";
import { z } from "zod";

import {
  DEFAULT_COUNTRY,
  DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE,
  DEFAULT_LOCATION_LIMIT,
  DEFAULT_LOCATION_PAGE,
  DEFAULT_TIMEZONE,
  LOCATION_ACTIVITIES,
  LOCATION_ACTIVITY_SELECTION_MODES,
  MAX_LOCATION_LIMIT,
  SLOT_STEP_MINUTES,
  WEEKDAYS,
} from "./location.constants.js";
import {
  buildLocationCode,
  normalizeLocationCode,
  slugifyLocation,
} from "./location.utils.js";

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CLOSE_TIME_REGEX = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

const stringSchema = (defaultValue = "") =>
  z.preprocess(
    (value) => (value === undefined || value === null ? defaultValue : value),
    z.string().trim(),
  );

const optionalBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean().optional());

const bodyBooleanSchema = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }

    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;

    return value;
  }, z.boolean());

const timezoneSchema = stringSchema(DEFAULT_TIMEZONE).refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, "Enter a valid IANA timezone.");

export const objectIdSchema = (fieldName = "id") =>
  z
    .string()
    .trim()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: `Invalid ${fieldName}.`,
    });

const addressSchema = z
  .object({
    line1: stringSchema(),
    line2: stringSchema(),
    city: stringSchema(),
    postalCode: stringSchema(),
    country: stringSchema(DEFAULT_COUNTRY),
  })
  .partial()
  .default({});

const contactSchema = z
  .object({
    email: stringSchema()
      .transform((value) => value.toLowerCase())
      .refine(
        (value) => !value || z.string().email().safeParse(value).success,
        "Invalid email.",
      ),
    phone: stringSchema(),
  })
  .partial()
  .default({});

const activityCapacitySchema = z.object({
  activity: z.enum(LOCATION_ACTIVITIES),
  capacity: z.coerce.number().int().min(1),
});

const slotStepMinutesSchema = z.coerce
  .number()
  .int()
  .refine(
    (value) => SLOT_STEP_MINUTES.includes(value as 15 | 30 | 60),
    "Invalid slot step minutes.",
  );

const bookingSchema = z
  .object({
    enabled: bodyBooleanSchema(true),
    timezone: timezoneSchema,
    slotStepMinutes: slotStepMinutesSchema.default(30),
    minBookingMinutes: z.coerce.number().int().min(15).default(60),
    maxBookingMinutes: z.coerce.number().int().min(15).default(360),
    allowPublicSoloOverlap: bodyBooleanSchema(false),
    maxPublicSoloOverlaps: z.coerce.number().int().min(1).default(1),
    globalCapacity: z.coerce.number().int().min(1).default(1),
    activitySelectionMode: z.enum(LOCATION_ACTIVITY_SELECTION_MODES),
    activityCapacities: z.array(activityCapacitySchema).default([]),
    privateSessionBlocksAll: bodyBooleanSchema(true),
    groupBookingBlocksAll: bodyBooleanSchema(true),
    doorCodeMinutesBefore: z.coerce.number().int().min(0).default(15),
  })
  .partial()
  .superRefine((value, ctx) => {
    if (
      value.minBookingMinutes !== undefined &&
      value.maxBookingMinutes !== undefined &&
      value.minBookingMinutes > value.maxBookingMinutes
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxBookingMinutes"],
        message:
          "Max booking minutes must be greater than or equal to min booking minutes.",
      });
    }
  })
  .default({});

const openingHoursDaySchema = z.object({
  isOpen: bodyBooleanSchema(true),
  openTime: stringSchema("06:00").refine(
    (value) => TIME_REGEX.test(value),
    "Invalid open time.",
  ),
  closeTime: stringSchema("24:00").refine(
    (value) => CLOSE_TIME_REGEX.test(value),
    "Invalid close time.",
  ),
});

const openingHoursShape = Object.fromEntries(
  WEEKDAYS.map((day) => [day, openingHoursDaySchema.partial().default({})]),
) as Record<string, z.ZodTypeAny>;

const openingHoursSchema = z.object(openingHoursShape).partial().default({});

const accessSchema = z
  .object({
    automaticEmailEnabled: optionalBooleanSchema,
    publicInstructions: stringSchema(),
    privateInstructions: stringSchema(),
    doorCode: stringSchema(),
  })
  .partial()
  .default({});

const baseLocationSchema = z.object({
  pricingMode: z.literal("time").nullable().optional(),
  firingSettings: z.never().optional(),
  name: stringSchema().pipe(z.string().min(1).max(160)),

  slug: stringSchema().transform((value) =>
    value ? slugifyLocation(value) : "",
  ),

  code: stringSchema().transform((value) =>
    value ? normalizeLocationCode(value) : "",
  ),

  address: addressSchema,
  contact: contactSchema,
  booking: bookingSchema,
  openingHours: openingHoursSchema,
  access: accessSchema,

  notes: stringSchema(),
});

export const createLocationSchema = baseLocationSchema.transform((value) => {
  const slug = value.slug || slugifyLocation(value.name);
  const code = value.code || buildLocationCode(slug);

  return {
    ...value,
    slug,
    code,
    booking: {
      ...value.booking,
      activitySelectionMode:
        value.booking.activitySelectionMode ??
        DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE,
    },
  };
});

export const updateLocationSchema = baseLocationSchema.partial().extend({
  id: objectIdSchema("location id"),
  // A deadline-only PATCH must not reset the other location sections to {}.
  address: addressSchema.removeDefault().optional(),
  contact: contactSchema.removeDefault().optional(),
  booking: bookingSchema.removeDefault().optional(),
  openingHours: openingHoursSchema.removeDefault().optional(),
  access: accessSchema.removeDefault().optional(),
});

export const listLocationsSchema = z.object({
  search: stringSchema(),
  isActive: optionalBooleanSchema,
  bookingEnabled: optionalBooleanSchema,
  page: z.coerce.number().int().positive().default(DEFAULT_LOCATION_PAGE),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_LOCATION_LIMIT)
    .default(DEFAULT_LOCATION_LIMIT),
});

export const locationIdParamsSchema = z.object({
  id: objectIdSchema("location id"),
});

export const setPrimaryLocationSchema = z.object({
  id: objectIdSchema("location id"),
});

export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;
export type ListLocationsInput = z.infer<typeof listLocationsSchema>;
