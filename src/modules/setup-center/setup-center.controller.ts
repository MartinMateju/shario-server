import type { Request, Response } from "express";
import type { z } from "zod";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";

import setupCenterService, {
  buildSetupCenterSnapshot,
  getSetupDiagnosticFallback,
} from "./setup-center.service.js";
import {
  setupAssistantSchema,
  setupLaunchEventSchema,
  setupPracticeActionParamsSchema,
  setupPracticeActionSchema,
  setupPracticeConfirmationSchema,
  setupPracticeStartSchema,
  setupPublicationSchema,
} from "./setup-center.validators.js";

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    badRequest({
      message: "Invalid Launch Center request.",
      code: "VALIDATION_ERROR",
      details: result.error.flatten(),
    });
  }
  return result.data;
};

const context = (req: Request) => ({
  tenantId: requireTenantId(req),
  actorUserId: getAuthenticatedUserId(req),
});

const send = (res: Response, data: unknown, status = 200) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json({ data });
};

export const getSetupCenter = asyncHandler(async (req, res) => {
  send(res, await setupCenterService.get(context(req)));
});

export const trackSetupLaunchEvent = asyncHandler(async (req, res) => {
  const input = parse(setupLaunchEventSchema, req.body);
  send(
    res,
    await setupCenterService.recordEvent({
      ...context(req),
      ...input,
    }),
    202,
  );
});

export const getSetupAssistantResponse = asyncHandler(async (req, res) => {
  const input = parse(setupAssistantSchema, req.body);
  const requestContext = context(req);
  const snapshot = await buildSetupCenterSnapshot(requestContext);
  const diagnostic = getSetupDiagnosticFallback({
    snapshot,
    stepId: input.stepId,
    locale: input.locale,
  });

  /*
   * The validated message is deliberately not sent to a model or used to
   * select data. The answer is derived only from the authoritative snapshot.
   */
  send(res, {
    answer: diagnostic.answer,
    navigation: diagnostic.navigation,
  });
});

export const startPractice = asyncHandler(async (req, res) => {
  const input = parse(setupPracticeStartSchema, req.body);
  send(
    res,
    await setupCenterService.startPractice({
      ...context(req),
      idempotencyKey: input.idempotencyKey,
    }),
    201,
  );
});

export const advancePractice = asyncHandler(async (req, res) => {
  const { action } = parse(setupPracticeActionParamsSchema, req.params);
  const { runId } = parse(setupPracticeActionSchema, req.body);
  send(
    res,
    await setupCenterService.applyPracticeAction({
      ...context(req),
      runId,
      actionKey: action,
    }),
  );
});

export const abandonPractice = asyncHandler(async (req, res) => {
  send(res, await setupCenterService.abandonPractice(context(req)));
});

export const confirmPractice = asyncHandler(async (req, res) => {
  const { expectedReadinessFingerprint } = parse(
    setupPracticeConfirmationSchema,
    req.body,
  );
  send(
    res,
    await setupCenterService.confirmPractice({
      ...context(req),
      expectedReadinessFingerprint,
    }),
  );
});

export const clearPracticeConfirmation = asyncHandler(async (req, res) => {
  send(res, await setupCenterService.clearPracticeConfirmation(context(req)));
});

export const publishCurrentStudio = asyncHandler(async (req, res) => {
  const input = parse(setupPublicationSchema, req.body);
  send(
    res,
    await setupCenterService.publish({
      ...context(req),
      expectedDefinitionVersion: input.expectedDefinitionVersion,
    }),
  );
});

export const unpublishCurrentStudio = asyncHandler(async (req, res) => {
  send(res, await setupCenterService.unpublish(context(req)));
});
