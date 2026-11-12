import mongoose, { Schema } from "mongoose";

import {
  DEFAULT_COUNTRY,
  DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE,
  DEFAULT_TIMEZONE,
  LOCATION_ACTIVITIES,
  LOCATION_ACTIVITY_SELECTION_MODES,
  type LocationActivitySelectionMode,
  SLOT_STEP_MINUTES,
} from "./location.constants.js";
import { buildLocationCode, slugifyLocation } from "./location.utils.js";

type OpeningHoursDay = {
  isOpen: boolean;
  openTime: string;
  closeTime: string;
};

type ActivityCapacity = {
  activity: string;
  capacity: number;
};

type LocationSchemaType = {
  tenant: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  code: string;
  isActive: boolean;
  isPrimary: boolean;
  pricingMode?: "time" | null;

  address: {
    line1: string;
    line2: string;
    city: string;
    postalCode: string;
    country: string;
  };

  contact: {
    email: string;
    phone: string;
  };

  booking: {
    enabled: boolean;
    timezone: string;
    slotStepMinutes: number;
    minBookingMinutes: number;
    maxBookingMinutes: number;
    allowPublicSoloOverlap: boolean;
    maxPublicSoloOverlaps: number;
    globalCapacity: number;
    activitySelectionMode?: LocationActivitySelectionMode;
    activityCapacities: ActivityCapacity[];
    privateSessionBlocksAll: boolean;
    groupBookingBlocksAll: boolean;
    doorCodeMinutesBefore: number;
    /**
     * Serialization point for transactional capacity reservations. It has no
     * business meaning; checkout increments it before re-reading overlaps.
     */
    capacityRevision: number;
  };

  openingHours: {
    monday: OpeningHoursDay;
    tuesday: OpeningHoursDay;
    wednesday: OpeningHoursDay;
    thursday: OpeningHoursDay;
    friday: OpeningHoursDay;
    saturday: OpeningHoursDay;
    sunday: OpeningHoursDay;
  };

  access: {
    automaticEmailEnabled?: boolean;
    publicInstructions: string;
    privateInstructions: string;
    doorCode: string;
  };

  notes: string;
  createdAt: Date;
  updatedAt: Date;
};

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CLOSE_TIME_REGEX = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
};

const openingHoursDaySchema = new Schema<OpeningHoursDay>(
  {
    isOpen: {
      type: Boolean,
      default: true,
    },
    openTime: {
      type: String,
      default: "06:00",
      match: TIME_REGEX,
    },
    closeTime: {
      type: String,
      default: "24:00",
      match: CLOSE_TIME_REGEX,
    },
  },
  { _id: false },
);

const activityCapacitySchema = new Schema<ActivityCapacity>(
  {
    activity: {
      type: String,
      enum: LOCATION_ACTIVITIES,
      required: true,
    },
    capacity: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false },
);

export const locationSchema = new Schema<LocationSchemaType>(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },

    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 160,
    },

    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      maxlength: 20,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isPrimary: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Null/absent inherits the workspace pricing choice; no existing data rewrite.
    pricingMode: {
      type: String,
      enum: ["time", null],
      default: null,
    },

    address: {
      line1: { type: String, trim: true, default: "" },
      line2: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      postalCode: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: DEFAULT_COUNTRY },
    },

    contact: {
      email: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
        validate: {
          validator(value: string) {
            return !value || EMAIL_REGEX.test(value);
          },
          message: "Invalid contact email.",
        },
      },
      phone: { type: String, trim: true, default: "" },
    },

    booking: {
      enabled: { type: Boolean, default: true },
      timezone: {
        type: String,
        trim: true,
        default: DEFAULT_TIMEZONE,
        validate: {
          validator: isValidTimezone,
          message: "Invalid IANA timezone.",
        },
      },
      slotStepMinutes: {
        type: Number,
        enum: SLOT_STEP_MINUTES,
        default: 30,
      },
      minBookingMinutes: { type: Number, default: 60, min: 15 },
      maxBookingMinutes: { type: Number, default: 360, min: 15 },
      allowPublicSoloOverlap: { type: Boolean, default: false },
      maxPublicSoloOverlaps: { type: Number, default: 1, min: 1 },
      globalCapacity: { type: Number, default: 1, min: 1 },
      activitySelectionMode: {
        type: String,
        enum: LOCATION_ACTIVITY_SELECTION_MODES,
        default: function () {
          // Historical documents must stay OPTIONAL through the runtime
          // resolver; only genuinely new model instances receive REQUIRED.
          return this.isNew === false
            ? undefined
            : DEFAULT_LOCATION_ACTIVITY_SELECTION_MODE;
        },
      },
      activityCapacities: {
        type: [activityCapacitySchema],
        default: [],
      },
      privateSessionBlocksAll: { type: Boolean, default: true },
      groupBookingBlocksAll: { type: Boolean, default: true },
      doorCodeMinutesBefore: { type: Number, default: 15, min: 0 },
      capacityRevision: {
        type: Number,
        default: 0,
        min: 0,
        select: false,
      },
    },

    openingHours: {
      monday: { type: openingHoursDaySchema, default: () => ({}) },
      tuesday: { type: openingHoursDaySchema, default: () => ({}) },
      wednesday: { type: openingHoursDaySchema, default: () => ({}) },
      thursday: { type: openingHoursDaySchema, default: () => ({}) },
      friday: { type: openingHoursDaySchema, default: () => ({}) },
      saturday: { type: openingHoursDaySchema, default: () => ({}) },
      sunday: { type: openingHoursDaySchema, default: () => ({}) },
    },

    access: {
      automaticEmailEnabled: { type: Boolean, default: false },
      publicInstructions: { type: String, trim: true, default: "" },
      privateInstructions: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
      doorCode: {
        type: String,
        trim: true,
        default: "",
        select: false,
      },
    },

    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

locationSchema.index({ tenant: 1, slug: 1 }, { unique: true });
locationSchema.index({ tenant: 1, code: 1 }, { unique: true });
locationSchema.index(
  { tenant: 1, isPrimary: 1 },
  {
    unique: true,
    name: "uniq_primary_location_per_tenant",
    partialFilterExpression: { isPrimary: true },
  },
);
locationSchema.index({ tenant: 1, isActive: 1 });
locationSchema.index({ tenant: 1, "booking.enabled": 1 });

locationSchema.pre("validate", function ensureSlugAndCode() {
  if (!this.slug && this.name) {
    this.slug = slugifyLocation(this.name);
  }

  if (!this.code && this.slug) {
    this.code = buildLocationCode(this.slug);
  }

  const minBookingMinutes = Number(this.booking?.minBookingMinutes || 0);
  const maxBookingMinutes = Number(this.booking?.maxBookingMinutes || 0);

  if (
    minBookingMinutes > 0 &&
    maxBookingMinutes > 0 &&
    minBookingMinutes > maxBookingMinutes
  ) {
    this.invalidate(
      "booking.maxBookingMinutes",
      "Max booking minutes must be greater than or equal to min booking minutes.",
    );
  }
});
