import mongoose from "mongoose";

import { EmailTemplate } from "./email-template.model.js";
import type { EmailTemplateDocument, EmailTemplateListFilters } from "./email-template.types.js";
import type { CreateEmailTemplateInput, UpdateEmailTemplateInput } from "./email-template.validators.js";
import { EmailTemplateCategory } from "./email-template.constants.js";

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const emailTemplateRepository = {
  async list(filters: EmailTemplateListFilters) {
    const query: Record<string, unknown> = {
      tenant: toObjectId(filters.tenantId),
    };

    if (filters.search) {
      const search = { $regex: escapeRegex(filters.search), $options: "i" };
      query.$or = [
        { name: search },
        { description: search },
        { subject: search },
        { "contentVariants.cs.subject": search },
        { "contentVariants.en.subject": search },
        { "contentVariants.cs.body": search },
        { "contentVariants.en.body": search },
      ];
    }

    if (filters.category && filters.category !== "all") {
      query.category = filters.category;
    }

    if (filters.type === "layout") {
      query.category = "layout";
    }

    if (filters.type === "content") {
      query.category = { $ne: "layout" };
    }

    if (typeof filters.active === "boolean") {
      query.isActive = filters.active;
    }

    return EmailTemplate.find(query)
      .populate("createdBy", "firstname lastname email")
      .sort({ isDefault: -1, createdAt: -1 })
      .limit(filters.limit || 100)
      .lean()
      .exec();
  },

  async findByIdForTenant(tenantId: string, templateId: string) {
    return EmailTemplate.findOne({
      _id: toObjectId(templateId),
      tenant: toObjectId(tenantId),
    })
      .populate("createdBy", "firstname lastname email")
      .lean()
      .exec();
  },

  async findDocumentByIdForTenant(
    tenantId: string,
    templateId: string,
  ): Promise<EmailTemplateDocument | null> {
    return EmailTemplate.findOne({
      _id: toObjectId(templateId),
      tenant: toObjectId(tenantId),
    }).exec();
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateEmailTemplateInput,
  ): Promise<EmailTemplateDocument> {
    return EmailTemplate.create({
      ...input,
      category: input.category as EmailTemplateCategory,
      tenant: toObjectId(tenantId),
      createdBy: toObjectId(createdBy),
    });
  },

  async update(
    tenantId: string,
    templateId: string,
    input: UpdateEmailTemplateInput,
  ): Promise<EmailTemplateDocument | null> {
    const template = await this.findDocumentByIdForTenant(tenantId, templateId);

    if (!template) {
      return null;
    }

    const { contentVariants, ...fields } = input;
    Object.assign(template, fields);
    if (contentVariants !== undefined) {
      template.set(
        "contentVariants",
        contentVariants as Record<string, unknown>,
      );
    }

    return template.save();
  },

  async setDefault(
    tenantId: string,
    templateId: string,
    category: EmailTemplateCategory,
  ): Promise<EmailTemplateDocument | null> {
    const tenant = toObjectId(tenantId);
    const template = toObjectId(templateId);
    const session = await mongoose.startSession();
    let updated: EmailTemplateDocument | null = null;

    try {
      await session.withTransaction(async () => {
        // Touch every template in the category so concurrent default changes
        // contend on the same document set and one transaction is retried.
        await EmailTemplate.updateMany(
          { tenant, category },
          { $set: { isDefault: false } },
          { session },
        ).exec();
        updated = await EmailTemplate.findOneAndUpdate(
          { _id: template, tenant, category },
          { $set: { isDefault: true, isActive: true } },
          { returnDocument: "after", runValidators: true, session },
        ).exec();
      });
    } finally {
      await session.endSession();
    }

    return updated;
  },

  async delete(tenantId: string, templateId: string): Promise<EmailTemplateDocument | null> {
    return EmailTemplate.findOneAndDelete({
      _id: toObjectId(templateId),
      tenant: toObjectId(tenantId),
    }).exec();
  },
};
