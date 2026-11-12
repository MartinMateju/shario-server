import CommunicationAutomation from "@/modules/communication-automations/communication-automation.model.js";
import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";

import type { EmailTemplateCategory } from "../email-template.constants.js";
import {
  assertValidEmailTemplateVariables,
  extractEmailTemplateVariables,
  hasDeliverableEmailTemplateContent,
  selectLocalizedEmailContent,
} from "../email-template.rendering.js";
import { emailTemplateRepository } from "../email-template.repository.js";
import type {
  EmailTemplateDocument,
  EmailTemplateListFilters,
} from "../email-template.types.js";
import type {
  CreateEmailTemplateInput,
  UpdateEmailTemplateInput,
} from "../email-template.validators.js";

const toPlainTemplate = (
  template: EmailTemplateDocument,
): Record<string, any> => template.toObject({ depopulate: true }) as Record<string, any>;

const mergeTemplate = (
  template: EmailTemplateDocument,
  input: UpdateEmailTemplateInput,
): Record<string, any> => {
  const current = toPlainTemplate(template);
  const replacesLocalizedContent = Object.prototype.hasOwnProperty.call(
    input,
    "contentVariants",
  );
  const candidate: Record<string, any> = {
    ...current,
    ...input,
    contentVariants: replacesLocalizedContent
      ? (input as Record<string, any>).contentVariants || {}
      : current.contentVariants || {},
  };

  // Keep the original top-level fields in sync for older workers and API
  // clients whenever localized content or its default changes.
  if (
    Object.prototype.hasOwnProperty.call(input, "contentVariants") ||
    Object.prototype.hasOwnProperty.call(input, "defaultLocale")
  ) {
    const selected = selectLocalizedEmailContent(
      candidate,
      candidate.defaultLocale,
    );
    if (!Object.prototype.hasOwnProperty.call(input, "subject")) {
      candidate.subject = selected.subject;
    }
    if (!Object.prototype.hasOwnProperty.call(input, "htmlContent")) {
      const selectedVariant = candidate.contentVariants?.[selected.locale];
      candidate.htmlContent = selectedVariant?.htmlContent || "";
    }
    if (!Object.prototype.hasOwnProperty.call(input, "body")) {
      candidate.body = selected.body;
    }
    if (!Object.prototype.hasOwnProperty.call(input, "format")) {
      candidate.format = selected.format;
    }
  }

  candidate.variables = extractEmailTemplateVariables(
    candidate.subject,
    candidate.htmlContent,
    candidate.body,
    candidate.headerHtml,
    candidate.footerHtml,
    ...Object.values(candidate.contentVariants || {}).flatMap((variant: any) => [
      variant?.subject,
      variant?.htmlContent,
      variant?.body,
    ]),
  );

  return candidate;
};

const assertTemplateHasDeliverableContent = (
  candidate: Record<string, any>,
): void => {
  if (candidate.category === "layout") return;
  if (!hasDeliverableEmailTemplateContent(candidate)) {
    badRequest("At least one complete localized email variant is required.");
  }

  const variants = Object.values(candidate.contentVariants || {});

  assertValidEmailTemplateVariables(
    candidate.subject,
    candidate.htmlContent,
    candidate.body,
    candidate.headerHtml,
    candidate.footerHtml,
    ...variants.flatMap((variant: any) => [
      variant?.subject,
      variant?.htmlContent,
      variant?.body,
    ]),
  );
};

const automationUsesTemplate = async (
  tenantId: string,
  templateId: string,
  activeOnly: boolean,
): Promise<boolean> =>
  Boolean(
    await CommunicationAutomation.exists({
      tenant: tenantId,
      templateId,
      ...(activeOnly ? { isActive: true } : {}),
    }).exec(),
  );

export const emailTemplateService = {
  async list(filters: EmailTemplateListFilters) {
    const templates = await emailTemplateRepository.list(filters);
    return { templates };
  },

  async getById(tenantId: string, templateId: string) {
    const template = await emailTemplateRepository.findByIdForTenant(
      tenantId,
      templateId,
    );

    if (!template) {
      notFound("Email template not found.");
    }

    return { template };
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateEmailTemplateInput,
  ) {
    assertTemplateHasDeliverableContent(input as Record<string, any>);
    const shouldBeDefault = input.isDefault === true;
    const category = input.category as EmailTemplateCategory;
    const template = await emailTemplateRepository.create(tenantId, createdBy, {
      ...input,
      isDefault: false,
    });

    if (shouldBeDefault) {
      await emailTemplateRepository.setDefault(
        tenantId,
        String(template._id),
        category,
      );
    }

    return this.getById(tenantId, String(template._id));
  },

  async update(
    tenantId: string,
    templateId: string,
    input: UpdateEmailTemplateInput,
  ) {
    const existing = await emailTemplateRepository.findDocumentByIdForTenant(
      tenantId,
      templateId,
    );
    if (!existing) notFound("Email template not found.");

    const candidate = mergeTemplate(existing, input);
    const remainsDeliverable = hasDeliverableEmailTemplateContent(candidate);
    if (
      (input.isActive === false || !remainsDeliverable) &&
      (await automationUsesTemplate(tenantId, templateId, true))
    ) {
      conflict(
        input.isActive === false
          ? "An active automation uses this email template."
          : "An active automation requires this template to remain a complete content template.",
      );
    }
    assertTemplateHasDeliverableContent(candidate);

    const category = candidate.category as EmailTemplateCategory;
    const categoryChanged = String(existing.category) !== String(category);
    const shouldBeDefault =
      input.isDefault === true ||
      (existing.isDefault && categoryChanged && input.isDefault !== false);
    const shouldClearDefault = input.isActive === false || input.isDefault === false;
    const updateInput = {
      ...input,
      subject: candidate.subject,
      htmlContent: candidate.htmlContent,
      body: candidate.body,
      format: candidate.format,
      variables: candidate.variables,
      ...(Object.prototype.hasOwnProperty.call(input, "contentVariants")
        ? { contentVariants: candidate.contentVariants }
        : {}),
      ...(shouldClearDefault || shouldBeDefault ? { isDefault: false } : {}),
    } as UpdateEmailTemplateInput;

    const template = await emailTemplateRepository.update(
      tenantId,
      templateId,
      updateInput,
    );
    if (!template) notFound("Email template not found.");

    if (shouldBeDefault && input.isActive !== false) {
      await emailTemplateRepository.setDefault(tenantId, templateId, category);
    }

    return this.getById(tenantId, templateId);
  },

  async delete(tenantId: string, templateId: string) {
    if (await automationUsesTemplate(tenantId, templateId, false)) {
      conflict(
        "This email template is referenced by an automation. Remove the template from the automation before deleting it.",
      );
    }

    const template = await emailTemplateRepository.delete(tenantId, templateId);

    if (!template) {
      notFound("Email template not found.");
    }

    return { message: "Email template deleted." };
  },

  async toggleActive(tenantId: string, templateId: string) {
    const template = await emailTemplateRepository.findDocumentByIdForTenant(
      tenantId,
      templateId,
    );

    if (!template) {
      notFound("Email template not found.");
    }

    if (
      template.isActive &&
      (await automationUsesTemplate(tenantId, templateId, true))
    ) {
      conflict("An active automation uses this email template.");
    }

    template.isActive = !template.isActive;
    if (!template.isActive) template.isDefault = false;
    await template.save();

    return this.getById(tenantId, templateId);
  },

  async setDefault(tenantId: string, templateId: string) {
    const template = await emailTemplateRepository.findDocumentByIdForTenant(
      tenantId,
      templateId,
    );

    if (!template) {
      notFound("Email template not found.");
    }

    const updated = await emailTemplateRepository.setDefault(
      tenantId,
      templateId,
      template.category,
    );
    if (!updated) notFound("Email template not found.");

    return this.getById(tenantId, templateId);
  },
};
