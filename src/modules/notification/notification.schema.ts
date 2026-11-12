import {
  EMAIL_NOTIFICATION_RECIPIENT_STATUS,
  EMAIL_REGEX,
} from "./notification.constants.js";
import mongoose from "mongoose";

const notifiedUserSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    userCustomId: {
      type: String,
      default: "",
      trim: true,
    },

    firstname: {
      type: String,
      default: "",
      trim: true,
    },

    lastname: {
      type: String,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
    },

    privateMessage: {
      type: String,
      default: "",
      trim: true,
    },

    photoUrl: {
      type: String,
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(EMAIL_NOTIFICATION_RECIPIENT_STATUS),
      default: EMAIL_NOTIFICATION_RECIPIENT_STATUS.SENT,
    },
  },
  { _id: false },
);

export const emailNotificationSchema = new mongoose.Schema(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    title: {
      type: String,
      default: "Hromadný e-mail",
      trim: true,
      maxlength: 160,
    },

    emailType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    subject: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },

    globalMessage: {
      type: String,
      default: "",
      trim: true,
    },

    relatedBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
      index: true,
    },

    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    sentAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    recipients: {
      type: [notifiedUserSchema],
      default: [],
    },

    totalRecipients: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

emailNotificationSchema.pre("validate", function normalizeTotalRecipients() {
  this.totalRecipients = Array.isArray(this.recipients)
    ? this.recipients.length
    : 0;
});

emailNotificationSchema.index({ tenant: 1, sentAt: -1 });
emailNotificationSchema.index({ tenant: 1, emailType: 1 });
emailNotificationSchema.index({ tenant: 1, relatedBooking: 1 });
emailNotificationSchema.index({ tenant: 1, sentBy: 1 });
