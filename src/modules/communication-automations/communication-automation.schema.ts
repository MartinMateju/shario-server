import mongoose from "mongoose";

import {
  COMMUNICATION_AUTOMATION_STATUS,
  COMMUNICATION_CONNECTED_PRODUCT_TYPE,
  COMMUNICATION_DAY_OF_WEEK,
  COMMUNICATION_SCHEDULE_TYPE,
  DEFAULT_DAY_OF_MONTH,
  DEFAULT_DAY_OF_WEEK,
  DEFAULT_MINUTES_OFFSET,
  DEFAULT_SEND_TIME,
  EMAIL_REGEX,
  TIME_REGEX,
  COMMUNICATION_CONTENT_LOCALE,
  MAX_AUTOMATION_OFFSET_MINUTES,
  COMMUNICATION_AUTOMATION_PURPOSE,
} from "./communication-automation.constants.js";
import type { CommunicationAutomationEntity } from "./communication-automation.types.js";
import {
  EMAIL_TEMPLATE_FORMAT,
  EMAIL_TEMPLATE_FORMATS,
} from "@/modules/email-template/email-template.constants.js";

const recipientSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: EMAIL_REGEX,
      default: "",
    },
    customId: {
      type: String,
      trim: true,
      default: "",
    },
    name: {
      type: String,
      trim: true,
      default: "",
    },
    locale: {
      type: String,
      enum: Object.values(COMMUNICATION_CONTENT_LOCALE),
      default: COMMUNICATION_CONTENT_LOCALE.CS,
    },
  },
  { _id: false },
);

const localizedContentSchema = new mongoose.Schema(
  {
    subject: { type: String, trim: true, default: "", maxlength: 240 },
    htmlContent: { type: String, default: "", maxlength: 250_000 },
    body: { type: String, default: "", maxlength: 100_000 },
    format: {
      type: String,
      enum: EMAIL_TEMPLATE_FORMATS,
      default: EMAIL_TEMPLATE_FORMAT.HTML,
    },
  },
  { _id: false },
);

export const communicationAutomationSchema = new mongoose.Schema<CommunicationAutomationEntity>(
  {
    tenant: {
      type: mongoose.Schema.Types.ObjectId,
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

    scheduleType: {
      type: String,
      enum: Object.values(COMMUNICATION_SCHEDULE_TYPE),
      required: true,
      index: true,
    },

    connectedProductType: {
      type: String,
      enum: Object.values(COMMUNICATION_CONNECTED_PRODUCT_TYPE),
      default: COMMUNICATION_CONNECTED_PRODUCT_TYPE.ALL,
      index: true,
    },

    automationStatus: {
      type: String,
      enum: Object.values(COMMUNICATION_AUTOMATION_STATUS),
      default: COMMUNICATION_AUTOMATION_STATUS.WAITING_TO_ACTIVATE,
      index: true,
    },

    minutesOffset: {
      type: Number,
      default: DEFAULT_MINUTES_OFFSET,
      min: 0,
      max: MAX_AUTOMATION_OFFSET_MINUTES,
    },

    sendTime: {
      type: String,
      default: DEFAULT_SEND_TIME,
      match: TIME_REGEX,
    },

    oneTimeSendAt: {
      type: Date,
      default: null,
    },

    dayOfWeek: {
      type: String,
      enum: Object.values(COMMUNICATION_DAY_OF_WEEK),
      default: DEFAULT_DAY_OF_WEEK,
    },

    dayOfMonth: {
      type: Number,
      default: DEFAULT_DAY_OF_MONTH,
      min: 1,
      max: 31,
    },

    senderEmail: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegisteredSenderEmail",
      required: true,
      index: true,
    },

    sendToAllRecipients: {
      type: Boolean,
      default: false,
    },

    recipients: {
      type: [recipientSchema],
      default: [],
    },

    subject: {
      type: String,
      default: "",
      trim: true,
      maxlength: 240,
    },

    htmlContent: {
      type: String,
      default: "",
    },

    body: {
      type: String,
      default: "",
    },

    format: {
      type: String,
      enum: EMAIL_TEMPLATE_FORMATS,
      default: EMAIL_TEMPLATE_FORMAT.HTML,
    },

    contentVariants: {
      [COMMUNICATION_CONTENT_LOCALE.CS]: {
        type: localizedContentSchema,
        default: undefined,
      },
      [COMMUNICATION_CONTENT_LOCALE.EN]: {
        type: localizedContentSchema,
        default: undefined,
      },
    },

    defaultLocale: {
      type: String,
      enum: Object.values(COMMUNICATION_CONTENT_LOCALE),
      default: COMMUNICATION_CONTENT_LOCALE.CS,
    },

    purpose: {
      type: String,
      enum: Object.values(COMMUNICATION_AUTOMATION_PURPOSE),
      default: COMMUNICATION_AUTOMATION_PURPOSE.TRANSACTIONAL,
      index: true,
    },

    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailTemplate",
      default: null,
      index: true,
    },

    respectQuietHours: {
      type: Boolean,
      default: true,
    },

    cancelOnReschedule: {
      type: Boolean,
      default: true,
    },

    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },

    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Location",
      default: null,
      index: true,
    },

    appliesToAllLocations: {
      type: Boolean,
      default: true,
      index: true,
    },

    lastRunAt: {
      type: Date,
      default: null,
    },

    nextRunAt: { type: Date, default: null, index: true },
    lastScheduledFor: { type: Date, default: null },
    runClaimedUntil: { type: Date, default: null, index: true },
    runClaimToken: { type: String, default: "", maxlength: 120 },
    runSequence: { type: Number, default: 0, min: 0 },

    activatedAt: {
      type: Date,
      default: null,
    },

    deactivatedAt: {
      type: Date,
      default: null,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    errorMessage: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

communicationAutomationSchema.pre("validate", function normalizeLocation() {
  if (this.appliesToAllLocations) {
    this.location = null;
  }

  if (!this.appliesToAllLocations && !this.location) {
    this.invalidate(
      "location",
      "Location is required when automation does not apply to all locations.",
    );
  }
});

communicationAutomationSchema.pre("save", function normalizeAutomation() {
  if (!this.body && this.htmlContent) {
    this.body = this.htmlContent;
  }

  if (!this.htmlContent && this.body) {
    this.htmlContent = this.body;
  }

  if (this.sendToAllRecipients) {
    this.recipients = [];
  }

  if (this.isActive && this.automationStatus !== COMMUNICATION_AUTOMATION_STATUS.ACTIVE) {
    this.automationStatus = COMMUNICATION_AUTOMATION_STATUS.ACTIVE;
    this.activatedAt = this.activatedAt || new Date();
    this.deactivatedAt = null;
    this.failedAt = null;
    this.errorMessage = "";
  }

  if (!this.isActive && this.automationStatus === COMMUNICATION_AUTOMATION_STATUS.ACTIVE) {
    this.automationStatus = COMMUNICATION_AUTOMATION_STATUS.INACTIVE;
    this.deactivatedAt = this.deactivatedAt || new Date();
  }
});

communicationAutomationSchema.index({ tenant: 1, createdAt: -1 });
communicationAutomationSchema.index({ tenant: 1, isActive: 1, automationStatus: 1, scheduleType: 1 });
communicationAutomationSchema.index({ isActive: 1, automationStatus: 1, nextRunAt: 1 });
communicationAutomationSchema.index({ tenant: 1, oneTimeSendAt: 1, isActive: 1, automationStatus: 1 });
communicationAutomationSchema.index({ tenant: 1, location: 1, appliesToAllLocations: 1 });
communicationAutomationSchema.index({ tenant: 1, connectedProductType: 1 });
communicationAutomationSchema.index({ tenant: 1, senderEmail: 1 });
communicationAutomationSchema.index({ tenant: 1, "recipients.email": 1 });
communicationAutomationSchema.index({ tenant: 1, "recipients.customId": 1 });
