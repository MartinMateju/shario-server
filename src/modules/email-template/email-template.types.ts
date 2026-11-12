import type { HydratedDocument, Model, Types } from "mongoose";

import type {
  EmailTemplateCategory,
  EmailTemplateFormat,
  EmailTemplateLocale,
} from "./email-template.constants.js";

export type LocalizedEmailTemplateContent = {
  subject: string;
  htmlContent: string;
  body: string;
  format: EmailTemplateFormat;
};

export type EmailTemplate = {
  tenant: Types.ObjectId;
  name: string;
  description: string;
  subject: string;
  htmlContent: string;
  body: string;
  format: EmailTemplateFormat;
  defaultLocale: EmailTemplateLocale;
  contentVariants: Partial<
    Record<EmailTemplateLocale, LocalizedEmailTemplateContent>
  >;
  headerHtml: string;
  footerHtml: string;
  logoUrl: string;
  primaryColor: string;
  variables: string[];
  category: EmailTemplateCategory;
  isDefault: boolean;
  isActive: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type EmailTemplateDocument = HydratedDocument<EmailTemplate>;

export type EmailTemplateModel = Model<EmailTemplate>;

export type EmailTemplateListFilters = {
  tenantId: string;
  search?: string;
  category?: string;
  active?: boolean | "all";
  type?: "all" | "layout" | "content";
  limit?: number;
};
