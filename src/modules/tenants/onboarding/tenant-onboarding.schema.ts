import { Schema } from "mongoose";

import { TENANT_STORED_BOOKING_TYPES } from "./tenant-onboarding.constants.js";

const BUSINESS_TYPES = [
  "coworking_space",
  "rehearsal_space",
  "community_space",
  "art_studio",
  "photography_studio",
  "wellness_studio",
  "other",
] as const;

const TEAM_SIZES = ["just_me", "2_5", "6_15", "16_plus"] as const;

const CONFIRMATION_MODES = ["instant", "manual"] as const;

const businessDetailsSchema = new Schema(
  {
    country: {
      type: String,
      trim: true,
      maxlength: 80,
      default: "",
    },

    city: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },

    address: {
      type: String,
      trim: true,
      maxlength: 240,
      default: "",
    },

    phone: {
      type: String,
      trim: true,
      maxlength: 40,
      default: "",
    },
  },
  {
    _id: false,
  },
);

const bookingSetupSchema = new Schema(
  {
    bookingTypes: {
      type: [String],
      // Legacy enum values must remain valid until existing onboarding
      // subdocuments have all been rewritten by a canonical save.
      enum: TENANT_STORED_BOOKING_TYPES,
      default: [],
    },

    confirmationMode: {
      type: String,
      enum: CONFIRMATION_MODES,
      default: undefined,
    },
  },
  {
    _id: false,
  },
);

export const tenantOnboardingSchema = new Schema(
  {
    completed: {
      type: Boolean,
      default: false,
    },

    currentStep: {
      type: Number,
      min: 1,
      max: 4,
      default: 1,
    },

    businessType: {
      type: String,
      enum: BUSINESS_TYPES,
      default: undefined,
    },

    teamSize: {
      type: String,
      enum: TEAM_SIZES,
      default: undefined,
    },

    businessDetails: {
      type: businessDetailsSchema,
      default: undefined,
    },

    bookingSetup: {
      type: bookingSetupSchema,
      default: undefined,
    },

    completedAt: {
      type: Date,
      default: undefined,
    },

    lastSavedAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    _id: false,
  },
);
