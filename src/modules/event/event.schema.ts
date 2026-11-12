import mongoose from "mongoose";

import { STUDIO_COMMERCE_CURRENCIES } from "@/shared/money/currency.js";

import { EMAIL_REGEX, EVENT_STATUSES, EVENT_TYPES, TIME_REGEX } from "./event.constants.js";

const eventChecklistItemSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    done: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true },
);

export const eventSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },

    type: {
      type: String,
      enum: EVENT_TYPES,
      default: "other",
      index: true,
    },

    status: {
      type: String,
      enum: EVENT_STATUSES,
      default: "inquiry",
      index: true,
    },

    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },

    externalLocationName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 200,
    },

    date: {
      type: Date,
      required: true,
      index: true,
    },

    startTime: {
      type: String,
      trim: true,
      match: TIME_REGEX,
      default: "",
    },

    endTime: {
      type: String,
      trim: true,
      match: TIME_REGEX,
      default: "",
    },

    customerName: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },

    contactPerson: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      default: "",
      maxlength: 254,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
      maxlength: 40,
    },

    numberOfGuests: {
      type: Number,
      default: 1,
      min: 1,
    },

    // Optional for backwards compatibility. New financial records always get
    // a server-derived tenant currency in the service layer.
    currency: {
      type: String,
      enum: STUDIO_COMMERCE_CURRENCIES,
      trim: true,
      uppercase: true,
      default: undefined,
    },

    priceEstimate: {
      type: Number,
      default: 0,
      min: 0,
    },

    finalPrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    depositPaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    assignedStaff: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },

    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },

    bookings: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Booking",
        },
      ],
      default: [],
    },

    notes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 5000,
    },

    internalNotes: {
      type: String,
      trim: true,
      default: "",
      maxlength: 5000,
    },

    checklist: {
      type: [eventChecklistItemSchema],
      default: [],
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Internal execution key used only to make confirmed AI actions retry-safe.
    // It is excluded from normal event reads and is never accepted from API DTOs.
    aiActionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      select: false,
    },
  },
  { timestamps: true },
);

eventSchema.index({ tenant: 1, date: 1 });
eventSchema.index({ tenant: 1, status: 1, date: 1 });
eventSchema.index({ tenant: 1, type: 1, date: 1 });
eventSchema.index({ tenant: 1, location: 1, date: 1 });
eventSchema.index({ tenant: 1, order: 1 });
eventSchema.index({ tenant: 1, createdBy: 1 });
eventSchema.index(
  { tenant: 1, aiActionId: 1 },
  {
    unique: true,
    partialFilterExpression: { aiActionId: { $type: "objectId" } },
  },
);
eventSchema.index({ tenant: 1, "assignedStaff": 1 });
eventSchema.index({ tenant: 1, email: 1, date: -1 });
