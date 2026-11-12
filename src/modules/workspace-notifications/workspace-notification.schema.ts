import mongoose, { Schema } from "mongoose";

import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  WORKSPACE_NOTIFICATION_CATEGORIES,
  WORKSPACE_NOTIFICATION_EVENTS,
  WORKSPACE_NOTIFICATION_SEVERITIES,
  WORKSPACE_NOTIFICATION_SEVERITY,
} from "./workspace-notification.constants.js";
import { isSafeWorkspaceNotificationActionUrl } from "./workspace-notification.utils.js";

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

export const workspaceNotificationSchema = new Schema(
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
    actor: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },
    eventType: {
      type: String,
      enum: WORKSPACE_NOTIFICATION_EVENTS,
      required: true,
      immutable: true,
    },
    category: {
      type: String,
      enum: WORKSPACE_NOTIFICATION_CATEGORIES,
      required: true,
      immutable: true,
    },
    severity: {
      type: String,
      enum: WORKSPACE_NOTIFICATION_SEVERITIES,
      default: WORKSPACE_NOTIFICATION_SEVERITY.INFO,
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
        validator: isSafeWorkspaceNotificationActionUrl,
        message: "Workspace notification action URL must remain inside /app.",
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
    requiredPermission: {
      type: String,
      enum: ["", ...ALL_WORKSPACE_PERMISSIONS],
      default: "",
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
  {
    timestamps: true,
    strict: true,
  },
);

workspaceNotificationSchema.index(
  { tenant: 1, recipient: 1, deduplicationKey: 1 },
  { unique: true, name: "workspace_notification_recipient_deduplication" },
);
workspaceNotificationSchema.index(
  { tenant: 1, recipient: 1, readAt: 1, _id: -1 },
  { name: "workspace_notification_recipient_unread" },
);
workspaceNotificationSchema.index(
  { tenant: 1, recipient: 1, location: 1, _id: -1 },
  { name: "workspace_notification_recipient_location" },
);
workspaceNotificationSchema.index(
  { tenant: 1, recipient: 1, category: 1, _id: -1 },
  { name: "workspace_notification_recipient_category" },
);
workspaceNotificationSchema.index(
  { tenant: 1, recipient: 1, groupKey: 1, _id: -1 },
  { name: "workspace_notification_recipient_group" },
);
