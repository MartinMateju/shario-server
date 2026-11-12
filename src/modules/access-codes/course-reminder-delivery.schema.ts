import mongoose from "mongoose";

import {
  COURSE_REMINDER_DELIVERY_STATUSES,
  COURSE_REMINDER_DELIVERY_STATUS,
} from "./course-reminder-delivery.constants.js";
import type { CourseReminderDelivery } from "./course-reminder-delivery.types.js";

export const courseReminderDeliverySchema =
  new mongoose.Schema<CourseReminderDelivery>(
    {
      tenant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Tenant",
        required: true,
        immutable: true,
      },
      booking: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Booking",
        required: true,
        immutable: true,
      },
      bookingStart: { type: Date, required: true, immutable: true },
      recipientUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        immutable: true,
      },
      recipientEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        maxlength: 254,
        immutable: true,
      },
      idempotencyKey: {
        type: String,
        required: true,
        trim: true,
        maxlength: 96,
        immutable: true,
      },
      messageId: {
        type: String,
        required: true,
        trim: true,
        maxlength: 180,
        immutable: true,
      },
      subject: {
        type: String,
        required: true,
        trim: true,
        maxlength: 300,
        immutable: true,
      },
      textContent: {
        type: String,
        required: true,
        maxlength: 12_000,
        immutable: true,
      },
      status: {
        type: String,
        enum: COURSE_REMINDER_DELIVERY_STATUSES,
        default: COURSE_REMINDER_DELIVERY_STATUS.PENDING,
        required: true,
      },
      attempts: { type: Number, min: 0, default: 0 },
      maxAttempts: { type: Number, min: 1, max: 8, default: 5 },
      processingStartedAt: { type: Date, default: null },
      claimToken: { type: String, trim: true, default: "", maxlength: 80 },
      leaseExpiresAt: { type: Date, default: null },
      providerAttemptStartedAt: { type: Date, default: null },
      manualReviewRequiredAt: { type: Date, default: null },
      nextAttemptAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      skippedAt: { type: Date, default: null },
      skipReason: {
        type: String,
        trim: true,
        default: "",
        maxlength: 1000,
      },
      provider: { type: String, trim: true, default: "", maxlength: 80 },
      providerMessageId: {
        type: String,
        trim: true,
        default: "",
        maxlength: 500,
      },
      failureCode: {
        type: String,
        trim: true,
        default: "",
        maxlength: 120,
      },
      failureMessage: {
        type: String,
        trim: true,
        default: "",
        maxlength: 3000,
      },
    },
    { timestamps: true },
  );

courseReminderDeliverySchema.index({ idempotencyKey: 1 }, { unique: true });
courseReminderDeliverySchema.index({ status: 1, leaseExpiresAt: 1 });
courseReminderDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
courseReminderDeliverySchema.index({ status: 1, manualReviewRequiredAt: 1 });
courseReminderDeliverySchema.index({
  tenant: 1,
  booking: 1,
  bookingStart: 1,
  status: 1,
});
