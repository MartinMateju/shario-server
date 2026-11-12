import { Schema } from "mongoose";
import { z } from "zod";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import {
  isSafePublicSiteText,
  isSafePublicSiteUrl,
} from "@/modules/tenants/public-site/tenant-public-site.validators.js";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      isSafePublicSiteText,
      "Use plain text without HTML or control characters.",
    );
const localized = (max: number) =>
  z
    .object(
      Object.fromEntries(
        ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [
          locale,
          text(max).optional(),
        ]),
      ),
    )
    .strict()
    .default({});

/** Additive presentation only: pricing, product identity and bookings stay canonical. */
export const courseContentInputSchema = z
  .object({
    name: localized(180),
    description: localized(4_000),
    details: localized(16_000),
    durationLabel: localized(120),
    locationIds: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-fA-F0-9]{24}$/)
          .transform((value) => value.toLowerCase()),
      )
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        "Select each location only once.",
      )
      .optional(),
    images: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .refine(
            (value) => isSafePublicSiteUrl(value),
            "Use a secure image URL or a site-relative image path.",
          ),
      )
      .max(12)
      .default([]),
  })
  .strict();

export type CourseContent = z.infer<typeof courseContentInputSchema>;

const localizedStorage = (max: number) =>
  new Schema(
    Object.fromEntries(
      ROLLOUT_ELIGIBLE_APP_LOCALES.map((locale) => [
        locale,
        {
          type: String,
          trim: true,
          maxlength: max,
          validate: isSafePublicSiteText,
        },
      ]),
    ),
    { _id: false },
  );

export const courseContentStorageSchema = new Schema(
  {
    name: { type: localizedStorage(180), default: () => ({}) },
    description: { type: localizedStorage(4_000), default: () => ({}) },
    details: { type: localizedStorage(16_000), default: () => ({}) },
    durationLabel: { type: localizedStorage(120), default: () => ({}) },
    locationIds: {
      type: [String],
      default: undefined,
      validate: (values: string[] | undefined) =>
        !values ||
        (values.length <= 100 &&
          new Set(values).size === values.length &&
          values.every((value) => /^[a-f0-9]{24}$/.test(value))),
    },
    images: {
      type: [String],
      default: () => [],
      validate: (values: string[]) =>
        values.length <= 12 &&
        values.every(
          (value) =>
            value.length > 0 &&
            value.length <= 2_000 &&
            isSafePublicSiteUrl(value),
        ),
    },
  },
  { _id: false },
);

export const serializeCourseContent = (
  value: unknown,
): CourseContent | undefined => {
  if (!value) return undefined;
  const source =
    typeof (value as any).toObject === "function"
      ? (value as any).toObject()
      : value;
  const parsed = courseContentInputSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
};

/** Publication scope only; it never changes a class session location. */
export const buildCoursePublicationLocationFilter = (locationId?: string) =>
  locationId
    ? {
        $or: [
          { "courseContent.locationIds.0": { $exists: false } },
          { "courseContent.locationIds": locationId },
        ],
      }
    : null;
