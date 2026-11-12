import mongoose, { Schema } from "mongoose";

import {
  DEFAULT_EMAIL_TEMPLATE_CATEGORY,
  DEFAULT_EMAIL_TEMPLATE_LOCALE,
  DEFAULT_EMAIL_TEMPLATE_PRIMARY_COLOR,
  EMAIL_TEMPLATE_CATEGORIES,
  EMAIL_TEMPLATE_FORMATS,
  EMAIL_TEMPLATE_LOCALES,
} from "./email-template.constants.js";
import type {
  EmailTemplate,
  EmailTemplateDocument,
  EmailTemplateModel,
} from "./email-template.types.js";

const localizedEmailContentSchema = new Schema(
  {
    subject: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
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
      default: "html",
    },
  },
  { _id: false },
);

export const emailTemplateSchema = new Schema<EmailTemplate, EmailTemplateModel>(
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
      maxlength: 120,
    },
    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },
    subject: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },
    htmlContent: {
      type: String,
      default: "",
    },
    // Retained alongside htmlContent for plain-text delivery and backwards
    // compatibility with the original automation editor payload.
    body: {
      type: String,
      default: "",
    },
    format: {
      type: String,
      enum: EMAIL_TEMPLATE_FORMATS,
      default: "html",
    },
    defaultLocale: {
      type: String,
      enum: EMAIL_TEMPLATE_LOCALES,
      default: DEFAULT_EMAIL_TEMPLATE_LOCALE,
      index: true,
    },
    contentVariants: {
      cs: {
        type: localizedEmailContentSchema,
        default: undefined,
      },
      en: {
        type: localizedEmailContentSchema,
        default: undefined,
      },
    },
    headerHtml: {
      type: String,
      default: "",
    },
    footerHtml: {
      type: String,
      default: "",
    },
    logoUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },
    primaryColor: {
      type: String,
      default: DEFAULT_EMAIL_TEMPLATE_PRIMARY_COLOR,
      trim: true,
    },
    variables: {
      type: [String],
      default: [],
    },
    category: {
      type: String,
      enum: EMAIL_TEMPLATE_CATEGORIES,
      default: DEFAULT_EMAIL_TEMPLATE_CATEGORY,
      index: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

emailTemplateSchema.index({ tenant: 1, category: 1 });
emailTemplateSchema.index({ tenant: 1, isDefault: 1 });
emailTemplateSchema.index({ tenant: 1, category: 1, isDefault: 1 });
