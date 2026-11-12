import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";

import {
  createRegisteredSenderEmailSchema,
  confirmReplyToVerificationSchema,
  listRegisteredSenderEmailsSchema,
  registeredSenderEmailIdParamsSchema,
  updateRegisteredSenderEmailSchema,
} from "../registered-sender-email.validators.js";

import { registeredSenderEmailService } from "../services/registered-sender-email.service.js";

export const getRegisteredSenderEmails = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listRegisteredSenderEmailsSchema.parse(req.query);
    const senderEmails = await registeredSenderEmailService.list(
      tenantId,
      input,
    );

    res.json(senderEmails);
  },
);

export const createRegisteredSenderEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createRegisteredSenderEmailSchema.parse(req.body);
    const senderEmail = await registeredSenderEmailService.createOrReactivate(
      tenantId,
      createdBy,
      input,
    );

    res.status(201).json(senderEmail);
  },
);

export const updateRegisteredSenderEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const input = updateRegisteredSenderEmailSchema.parse(req.body);
    const senderEmail = await registeredSenderEmailService.update(
      tenantId,
      id,
      input,
    );

    res.json(senderEmail);
  },
);

export const getRegisteredSenderEmailDetails = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const senderEmail = await registeredSenderEmailService.getDetails(
      tenantId,
      id,
    );

    res.json(senderEmail);
  },
);

export const testRegisteredSenderEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const result = await registeredSenderEmailService.test(tenantId, id);

    res.json(result);
  },
);

export const requestRegisteredSenderReplyToVerification = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const result =
      await registeredSenderEmailService.requestReplyToVerification(
        tenantId,
        id,
      );
    res.json(result);
  },
);

export const confirmRegisteredSenderReplyToVerification = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const input = confirmReplyToVerificationSchema.parse(req.body);
    const result =
      await registeredSenderEmailService.confirmReplyToVerification(
        tenantId,
        id,
        input,
      );
    res.json(result);
  },
);

export const deactivateRegisteredSenderEmail = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = registeredSenderEmailIdParamsSchema.parse(req.params);
    const senderEmail = await registeredSenderEmailService.deactivate(
      tenantId,
      id,
    );

    res.json(senderEmail);
  },
);
