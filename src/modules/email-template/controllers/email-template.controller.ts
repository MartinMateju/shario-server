import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { emailTemplateService } from "../services/email-template.service.js";
import {
  createEmailTemplateSchema,
  emailTemplateIdParamsSchema,
  listEmailTemplatesQuerySchema,
  updateEmailTemplateSchema,
} from "../email-template.validators.js";

export const getEmailTemplates = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listEmailTemplatesQuerySchema.parse(req.query);

    const result = await emailTemplateService.list({
      tenantId,
      ...filters,
    });

    res.status(200).json(result);
  },
);

export const getEmailTemplateById = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = emailTemplateIdParamsSchema.parse(req.params);

    const result = await emailTemplateService.getById(tenantId, id);

    res.status(200).json(result);
  },
);

export const createEmailTemplate = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createEmailTemplateSchema.parse(req.body);

    const result = await emailTemplateService.create(
      tenantId,
      createdBy,
      input,
    );

    res.status(201).json(result);
  },
);

export const updateEmailTemplate = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = emailTemplateIdParamsSchema.parse(req.params);
    const input = updateEmailTemplateSchema.parse(req.body);

    const result = await emailTemplateService.update(tenantId, id, input);

    res.status(200).json(result);
  },
);

export const deleteEmailTemplate = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = emailTemplateIdParamsSchema.parse(req.params);

    const result = await emailTemplateService.delete(tenantId, id);

    res.status(200).json(result);
  },
);

export const toggleEmailTemplateActive = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = emailTemplateIdParamsSchema.parse(req.params);

    const result = await emailTemplateService.toggleActive(tenantId, id);

    res.status(200).json(result);
  },
);

export const setDefaultEmailTemplate = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = emailTemplateIdParamsSchema.parse(req.params);

    const result = await emailTemplateService.setDefault(tenantId, id);

    res.status(200).json(result);
  },
);