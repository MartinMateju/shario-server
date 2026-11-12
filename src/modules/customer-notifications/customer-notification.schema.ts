import mongoose, { Schema } from "mongoose";

import {
  CUSTOMER_NOTIFICATION_CATEGORIES,
  CUSTOMER_NOTIFICATION_EVENTS,
  CUSTOMER_NOTIFICATION_SEVERITIES,
  CUSTOMER_NOTIFICATION_SEVERITY,
} from "./customer-notification.constants.js";
import { isSafeCustomerNotificationActionUrl } from "./customer-notification.utils.js";

const localizedTitleSchema = new Schema(
  {
    cs: { type: String, required: true, trim: true, maxlength: 180 },
    en: { type: String, required: true, trim: true, maxlength: 180 },
  },
  { _id: false },
);

const localizedMessageSchema = new Schema(
  {
    cs: { type: String, required: true, trim: true, maxlength: 1_000 },
    en: { type: String, required: true, trim: true, maxlength: 1_000 },
  },
  { _id: false },
);

export const customerNotificationSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      immutable: true,
    },
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    location: {
      type: Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      immutable: true,
    },
    eventType: {
      type: String,
      enum: CUSTOMER_NOTIFICATION_EVENTS,
      required: true,
      immutable: true,
    },
    category: {
      type: String,
      enum: CUSTOMER_NOTIFICATION_CATEGORIES,
      required: true,
      immutable: true,
    },
    severity: {
      type: String,
      enum: CUSTOMER_NOTIFICATION_SEVERITIES,
      default: CUSTOMER_NOTIFICATION_SEVERITY.INFO,
      required: true,
    },
    title: { type: localizedTitleSchema, required: true },
    message: { type: localizedMessageSchema, required: true },
    actionUrl: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
      validate: {
        validator: isSafeCustomerNotificationActionUrl,
        message: "Customer notification action URL must remain inside /portal.",
      },
    },
    sourceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      immutable: true,
    },
    sourceId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
      immutable: true,
    },
    deduplicationKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
      immutable: true,
    },
    groupKey: {
      type: String,
      trim: true,
      default: "",
      maxlength: 240,
      immutable: true,
    },
    occurrenceCount: {
      type: Number,
      min: 1,
      default: 1,
      required: true,
    },
    occurredAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, strict: true },
);

customerNotificationSchema.index(
  { tenant: 1, recipient: 1, deduplicationKey: 1 },
  { unique: true, name: "customer_notification_recipient_deduplication" },
);
customerNotificationSchema.index(
  { tenant: 1, recipient: 1, readAt: 1, _id: -1 },
  { name: "customer_notification_recipient_unread" },
);
customerNotificationSchema.index(
  { tenant: 1, recipient: 1, location: 1, _id: -1 },
  { name: "customer_notification_recipient_location" },
);
customerNotificationSchema.index(
  { tenant: 1, recipient: 1, category: 1, _id: -1 },
  { name: "customer_notification_recipient_category" },
);
customerNotificationSchema.index(
  { tenant: 1, recipient: 1, groupKey: 1, _id: -1 },
  { name: "customer_notification_recipient_group" },
);
