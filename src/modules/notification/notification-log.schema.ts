import mongoose from "mongoose";

import {
  EMAIL_REGEX,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_STATUS,
} from "./notification.constants.js";

export const notificationLogSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },

    type: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    channel: {
      type: String,
      enum: Object.values(NOTIFICATION_CHANNEL),
      default: NOTIFICATION_CHANNEL.EMAIL,
    },

    recipient: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      index: true,
    },

    subject: {
      type: String,
      trim: true,
      default: "",
    },

    html: {
      type: String,
      default: "",
    },

    status: {
      type: String,
      enum: Object.values(NOTIFICATION_STATUS),
      default: NOTIFICATION_STATUS.PENDING,
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    providerMessageId: {
      type: String,
      trim: true,
      default: "",
    },

    errorMessage: {
      type: String,
      default: "",
    },

    sentAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

notificationLogSchema.index({ tenant: 1, createdAt: -1 });
notificationLogSchema.index({ tenant: 1, user: 1, createdAt: -1 });
notificationLogSchema.index({ tenant: 1, booking: 1, type: 1 });
notificationLogSchema.index({ tenant: 1, status: 1, createdAt: -1 });
notificationLogSchema.index({ tenant: 1, recipient: 1, createdAt: -1 });
notificationLogSchema.index({ tenant: 1, type: 1, channel: 1 });
