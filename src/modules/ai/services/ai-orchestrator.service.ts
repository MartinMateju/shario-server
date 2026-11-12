import { randomUUID } from "node:crypto";

import type { z } from "zod";

import { logger } from "@/config/logger.js";
import { conflict } from "@/shared/http/httpErrors.js";

import {
  AI_FEATURE,
  AI_FEATURE_CREDIT_RESERVATION,
  AI_CREDITS_PER_TOKEN_BLOCK,
  AI_RUN_STATUS,
  type AiFeature,
} from "../ai.constants.js";
import { AiRunModel } from "../ai.models.js";
import type {
  AiProviderFailureCode,
  AiProviderResult,
  AiRequestContext,
  AiStructuredExecution,
} from "../ai.types.js";
import { requireAiEntitlement } from "./ai-access.service.js";
import {
  isOpenAiConfigured,
  createStructuredResponse,
  transcribeAudio,
} from "./openai.provider.js";
import {
  releaseAiCredits,
  reserveAiCredits,
  settleAiCredits,
} from "./ai-usage.service.js";

const featureSetting = (feature: AiFeature) => {
  if (
    feature === AI_FEATURE.COMMUNICATION_ANALYSIS ||
    feature === AI_FEATURE.COMMUNICATION_DRAFT ||
    feature === AI_FEATURE.TRANSLATION ||
    feature === AI_FEATURE.TRANSCRIPTION
  )
    return "communicationsCopilotEnabled" as const;
  if (feature === AI_FEATURE.STUDIO_ASSISTANT)
    return "assistantEnabled" as const;
  if (feature === AI_FEATURE.DAILY_BRIEFING)
    return "dailyBriefingEnabled" as const;
  if (feature === AI_FEATURE.BUSINESS_ADVISOR)
    return "businessAdvisorEnabled" as const;
  if (feature === AI_FEATURE.REPORT_INSIGHTS)
    return "reportInsightsEnabled" as const;
  if (feature === AI_FEATURE.STAFF_PLANNING)
    return "staffPlanningEnabled" as const;
  if (feature === AI_FEATURE.CUSTOMER_CONCIERGE)
    return "customerConciergeEnabled" as const;
  if (feature === AI_FEATURE.PUBLIC_CONCIERGE)
    return "publicConciergeEnabled" as const;
  if (feature === AI_FEATURE.FIRING_INTELLIGENCE)
    return "firingIntelligenceEnabled" as const;
  if (
    feature === AI_FEATURE.KNOWLEDGE_RETRIEVAL ||
    feature === AI_FEATURE.KNOWLEDGE_EMBEDDING
  ) {
    return "knowledgeBaseEnabled" as const;
  }
  return undefined;
};

const safeOutputSummary = (value: unknown): string => {
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return "";
  }
};

const normalizeStoredAiProviderFailure = (
  code: unknown,
): AiProviderFailureCode | undefined => {
  if (code === "AI_PROVIDER_UNAVAILABLE") return "AI_PROVIDER_UPSTREAM";
  if (
    code === "AI_PROVIDER_SCHEMA_INVALID" ||
    code === "AI_PROVIDER_RATE_LIMITED" ||
    code === "AI_PROVIDER_TIMEOUT" ||
    code === "AI_PROVIDER_AUTHENTICATION" ||
    code === "AI_PROVIDER_UPSTREAM"
  ) {
    return code;
  }
  return undefined;
};

export const classifyAiProviderFailure = (
  error: unknown,
): AiProviderFailureCode => {
  const providerError = error as {
    status?: number;
    providerCode?: string;
    providerParam?: string;
  };
  const status = Number(providerError?.status);
  const providerCode = String(providerError?.providerCode || "").toLowerCase();
  const providerParam = String(providerError?.providerParam || "").toLowerCase();
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error || "").toLowerCase();
  if (
    providerCode === "invalid_json_schema" ||
    providerParam === "text.format.schema" ||
    message.includes("invalid_json_schema") ||
    message.includes("invalid schema") ||
    message.includes("strict json schema") ||
    message.includes("text.format.schema")
  ) {
    return "AI_PROVIDER_SCHEMA_INVALID";
  }
  if (
    status === 429 ||
    /\b(status\s*)?429\b/.test(message) ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return "AI_PROVIDER_RATE_LIMITED";
  }
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborterror") ||
    message.includes("aborted")
  ) {
    return "AI_PROVIDER_TIMEOUT";
  }
  if (
    status === 401 ||
    status === 403 ||
    /\b(status\s*)?(401|403)\b/.test(message) ||
    message.includes("invalid_api_key") ||
    message.includes("authentication")
  ) {
    return "AI_PROVIDER_AUTHENTICATION";
  }
  return "AI_PROVIDER_UPSTREAM";
};

const releaseAiCreditsBestEffort = async ({
  reservationId,
  tenantId,
  feature,
  runId,
}: {
  reservationId: string;
  tenantId: string;
  feature: AiFeature;
  runId: string;
}): Promise<void> => {
  try {
    await releaseAiCredits(reservationId);
  } catch {
    logger.error(
      { tenantId, feature, runId },
      "AI credit reservation cleanup failed.",
    );
  }
};

const staleRunCutoff = () => {
  const configured = Number(process.env.AI_PENDING_RUN_STALE_MS || 5 * 60_000);
  const milliseconds = Number.isFinite(configured)
    ? Math.min(Math.max(configured, 60_000), 60 * 60_000)
    : 5 * 60_000;
  return new Date(Date.now() - milliseconds);
};

export const createAiIdempotencyKey = (
  prefix: string,
  stablePart?: string,
): string => `${prefix}:${stablePart || randomUUID()}`.slice(0, 300);

export const executeStructuredAi = async <T>({
  context,
  feature,
  promptVersion,
  idempotencyKey = createAiIdempotencyKey(feature),
  instructions,
  input,
  schema,
  schemaName,
  fallback,
  model,
  maxOutputTokens,
  sourceIds = [],
  deterministicValue,
  metadata,
}: {
  context: AiRequestContext;
  feature: AiFeature;
  promptVersion: string;
  idempotencyKey?: string;
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  fallback: () => T | Promise<T>;
  model?: string;
  maxOutputTokens?: number;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Use for server-verified, exact facts that must not be paraphrased or
   * overridden by a model. The run is still persisted for auditability.
   */
  deterministicValue?: T;
}): Promise<AiStructuredExecution<T>> => {
  await requireAiEntitlement(context.tenantId, featureSetting(feature));

  const selectedModel = model || process.env.OPENAI_MODEL || "gpt-5.6-terra";
  let run = await AiRunModel.findOne({
    tenant: context.tenantId,
    idempotencyKey,
  }).select("+structuredResult");
  let createdRun = false;
  if (!run) {
    try {
      run = await AiRunModel.create({
        tenant: context.tenantId,
        actor: context.userId || null,
        audience: context.audience,
        feature,
        promptVersion,
        provider: isOpenAiConfigured() ? "openai" : "deterministic",
        model: selectedModel,
        idempotencyKey,
        locationId: context.locationId || null,
        sourceIds,
        ...(metadata ? { metadata } : {}),
      });
      createdRun = true;
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      run = await AiRunModel.findOne({
        tenant: context.tenantId,
        idempotencyKey,
      }).select("+structuredResult");
      if (!run) throw error;
    }
  }

  if (!createdRun) {
    if (
      [AI_RUN_STATUS.FALLBACK, AI_RUN_STATUS.REFUSED].includes(
        run.status as never,
      ) &&
      (run.structuredResult === null || run.structuredResult === undefined)
    ) {
      const reclaimed = await AiRunModel.findOneAndUpdate(
        {
          _id: run._id,
          tenant: context.tenantId,
          status: run.status,
          structuredResult: { $in: [null, undefined] },
        },
        {
          $set: {
            status: AI_RUN_STATUS.PENDING,
            actor: context.userId || null,
            audience: context.audience,
            feature,
            promptVersion,
            provider: isOpenAiConfigured() ? "openai" : "deterministic",
            model: selectedModel,
            locationId: context.locationId || null,
            sourceIds,
            metadata: metadata || {},
            refusal: "",
            errorCode: "",
            errorMessage: "",
            providerResponseId: "",
            outputSummary: "",
            usage: {},
          },
          $unset: { completedAt: 1, structuredResult: 1 },
        },
        { returnDocument: "after" },
      ).select("+structuredResult");
      if (reclaimed) {
        run = reclaimed;
        createdRun = true;
      }
    }

    if (
      [
        AI_RUN_STATUS.COMPLETED,
        AI_RUN_STATUS.FALLBACK,
        AI_RUN_STATUS.REFUSED,
      ].includes(run.status as never) &&
      run.structuredResult !== null &&
      run.structuredResult !== undefined
    ) {
      const fallbackReason = normalizeStoredAiProviderFailure(run.errorCode);
      return {
        value: run.structuredResult as T,
        runId: String(run._id),
        provider:
          run.status === AI_RUN_STATUS.COMPLETED && run.provider === "openai"
            ? "openai"
            : "deterministic",
        model: run.model,
        usage: {
          inputTokens: Number(run.usage?.inputTokens || 0),
          outputTokens: Number(run.usage?.outputTokens || 0),
          totalTokens: Number(run.usage?.totalTokens || 0),
        },
        credits: Number(run.usage?.settledCredits || 0),
        ...(fallbackReason ? { fallbackReason } : {}),
      };
    }

    if (
      run.status === AI_RUN_STATUS.PENDING &&
      run.updatedAt < staleRunCutoff()
    ) {
      const reclaimed = await AiRunModel.findOneAndUpdate(
        {
          _id: run._id,
          tenant: context.tenantId,
          status: AI_RUN_STATUS.PENDING,
          updatedAt: { $lt: staleRunCutoff() },
        },
        {
          $set: {
            actor: context.userId || null,
            audience: context.audience,
            feature,
            promptVersion,
            provider: isOpenAiConfigured() ? "openai" : "deterministic",
            model: selectedModel,
            locationId: context.locationId || null,
            sourceIds,
            metadata: metadata || {},
            errorCode: "",
            errorMessage: "",
            refusal: "",
          },
          $unset: { completedAt: 1, structuredResult: 1 },
        },
        { returnDocument: "after" },
      ).select("+structuredResult");
      if (reclaimed) {
        run = reclaimed;
        createdRun = true;
      }
    }

    if (!createdRun) {
      conflict({
        message: "This AI request is already being processed.",
        code: "AI_REQUEST_IN_PROGRESS",
        details: { runId: String(run._id) },
      });
    }
  }

  if (deterministicValue !== undefined || !isOpenAiConfigured()) {
    const value =
      deterministicValue !== undefined ? deterministicValue : await fallback();
    run.status = AI_RUN_STATUS.FALLBACK;
    run.provider = "deterministic";
    run.model =
      deterministicValue !== undefined
        ? "verified-workspace-facts-v1"
        : "deterministic-v1";
    run.outputSummary = safeOutputSummary(value);
    run.structuredResult = value;
    run.completedAt = new Date();
    await run.save();
    return {
      value,
      runId: String(run._id),
      provider: "deterministic",
      model: run.model,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      credits: 0,
    };
  }

  let reservation: any;
  try {
    const conservativeTokenCeiling = Math.ceil(
      (instructions.length + input.length) / 2 + (maxOutputTokens || 2_000),
    );
    const defaultReservation = AI_FEATURE_CREDIT_RESERVATION[feature] || 5;
    const reservationCredits = Math.max(
      defaultReservation,
      Math.ceil(conservativeTokenCeiling / AI_CREDITS_PER_TOKEN_BLOCK),
    );
    reservation = await reserveAiCredits({
      tenantId: context.tenantId,
      actorId: context.userId,
      feature,
      idempotencyKey: `usage:${idempotencyKey}`,
      credits: reservationCredits,
    });
  } catch (error) {
    // No provider call happened. Remove only the still-pending run claimed by
    // this request so quota recovery can retry the same idempotency key later.
    await AiRunModel.deleteOne({ _id: run._id, status: AI_RUN_STATUS.PENDING });
    throw error;
  }

  let result: AiProviderResult<T>;
  try {
    result = await createStructuredResponse({
      instructions,
      input,
      schema,
      schemaName,
      model: selectedModel,
      maxOutputTokens,
    });
  } catch (error) {
    const failureCode = classifyAiProviderFailure(error);
    const runId = String(run._id);
    const logProviderFailure =
      failureCode === "AI_PROVIDER_SCHEMA_INVALID" ||
      failureCode === "AI_PROVIDER_AUTHENTICATION"
        ? logger.error.bind(logger)
        : logger.warn.bind(logger);
    logProviderFailure(
      {
        err: error,
        tenantId: context.tenantId,
        feature,
        runId,
        failureCode,
      },
      "AI provider request failed; deterministic fallback used.",
    );
    run.status = AI_RUN_STATUS.FALLBACK;
    run.provider = "deterministic";
    run.model = "deterministic-v1";
    run.errorCode = failureCode;
    run.errorMessage =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "AI provider failed.";
    run.completedAt = new Date();
    try {
      await run.save();
    } finally {
      await releaseAiCreditsBestEffort({
        reservationId: String(reservation._id),
        tenantId: context.tenantId,
        feature,
        runId,
      });
    }
    const value = await fallback();
    run.outputSummary = safeOutputSummary(value);
    run.structuredResult = value;
    await run.save();
    return {
      value,
      runId,
      provider: "deterministic",
      model: "deterministic-v1",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      credits: 0,
      fallbackReason: failureCode,
    };
  }

  try {
    if (result.refusal) {
      run.status = AI_RUN_STATUS.REFUSED;
      run.refusal = result.refusal;
      run.providerResponseId = result.responseId;
      run.model = result.model;
      run.usage = {
        ...result.usage,
        reservedCredits: reservation.reservedCredits,
      };
      run.completedAt = new Date();
      await run.save();
      const settled = await settleAiCredits({
        reservationId: String(reservation._id),
        usage: result.usage,
        model: result.model,
        runId: String(run._id),
      });
      const value = await fallback();
      run.structuredResult = value;
      run.outputSummary = safeOutputSummary(value);
      run.usage.settledCredits = Number(settled?.settledCredits || 0);
      await run.save();
      return {
        value,
        runId: String(run._id),
        provider: "deterministic",
        model: result.model,
        usage: result.usage,
        credits: Number(settled?.settledCredits || 0),
      };
    }

    run.status = AI_RUN_STATUS.COMPLETED;
    run.provider = "openai";
    run.model = result.model;
    run.providerResponseId = result.responseId;
    run.outputSummary = safeOutputSummary(result.value);
    run.structuredResult = result.value;
    run.usage = {
      ...result.usage,
      reservedCredits: reservation.reservedCredits,
    };
    run.completedAt = new Date();
    await run.save();

    const settled = await settleAiCredits({
      reservationId: String(reservation._id),
      usage: result.usage,
      model: result.model,
      runId: String(run._id),
    });
    run.usage.settledCredits = Number(settled?.settledCredits || 0);
    await run.save();

    return {
      value: result.value,
      runId: String(run._id),
      provider: "openai",
      model: result.model,
      usage: result.usage,
      credits: Number(settled?.settledCredits || 0),
    };
  } catch (error) {
    await releaseAiCreditsBestEffort({
      reservationId: String(reservation._id),
      tenantId: context.tenantId,
      feature,
      runId: String(run._id),
    });
    logger.error(
      {
        tenantId: context.tenantId,
        feature,
        runId: String(run._id),
      },
      "AI orchestration failed after a provider response.",
    );
    throw error;
  }
};

export const executeAudioTranscriptionAi = async ({
  context,
  idempotencyKey,
  audio,
  filename,
  contentType,
  language,
}: {
  context: AiRequestContext;
  idempotencyKey: string;
  audio: Buffer;
  filename: string;
  contentType: string;
  language?: string;
}) => {
  await requireAiEntitlement(context.tenantId, "communicationsCopilotEnabled");
  const feature = AI_FEATURE.TRANSCRIPTION;
  const selectedModel =
    process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  let run = await AiRunModel.findOne({
    tenant: context.tenantId,
    idempotencyKey,
  }).select("+structuredResult");

  if (
    run?.structuredResult &&
    [AI_RUN_STATUS.COMPLETED, AI_RUN_STATUS.FALLBACK].includes(run.status)
  ) {
    return {
      ...run.structuredResult,
      runId: String(run._id),
      provider: run.provider === "openai" ? "openai" : "deterministic",
      model: run.model,
      credits: Number(run.usage?.settledCredits || 0),
    };
  }
  if (run) {
    const cutoff = staleRunCutoff();
    if (run.status !== AI_RUN_STATUS.PENDING || run.updatedAt >= cutoff) {
      conflict({
        message: "This AI request is already being processed.",
        code: "AI_REQUEST_IN_PROGRESS",
        details: { runId: String(run._id) },
      });
    }
    const reclaimed = await AiRunModel.findOneAndUpdate(
      {
        _id: run._id,
        tenant: context.tenantId,
        status: AI_RUN_STATUS.PENDING,
        updatedAt: { $lt: cutoff },
      },
      {
        $set: {
          status: AI_RUN_STATUS.PENDING,
          actor: context.userId || null,
          audience: context.audience,
          feature,
          promptVersion: "communication-transcription-v1",
          provider: isOpenAiConfigured() ? "openai" : "deterministic",
          model: selectedModel,
          locationId: context.locationId || null,
          errorCode: "",
          errorMessage: "",
          refusal: "",
        },
        $unset: { completedAt: 1, structuredResult: 1 },
      },
      { returnDocument: "after" },
    ).select("+structuredResult");
    if (!reclaimed) {
      conflict({
        message: "This AI request is already being processed.",
        code: "AI_REQUEST_IN_PROGRESS",
        details: { runId: String(run._id) },
      });
    }
    run = reclaimed;
  } else {
    try {
      run = await AiRunModel.create({
        tenant: context.tenantId,
        actor: context.userId || null,
        audience: context.audience,
        feature,
        promptVersion: "communication-transcription-v1",
        provider: isOpenAiConfigured() ? "openai" : "deterministic",
        model: selectedModel,
        idempotencyKey,
        locationId: context.locationId || null,
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      conflict({
        message: "This AI request is already being processed.",
        code: "AI_REQUEST_IN_PROGRESS",
      });
    }
  }

  const fallback = { text: "", language: language || "" };
  if (!isOpenAiConfigured()) {
    run.status = AI_RUN_STATUS.FALLBACK;
    run.provider = "deterministic";
    run.model = "unavailable";
    run.structuredResult = fallback;
    run.outputSummary = "Transcription provider is not configured.";
    run.completedAt = new Date();
    await run.save();
    return {
      ...fallback,
      runId: String(run._id),
      provider: "deterministic" as const,
      model: run.model,
      credits: 0,
    };
  }

  let reservation: any;
  try {
    reservation = await reserveAiCredits({
      tenantId: context.tenantId,
      actorId: context.userId,
      feature,
      idempotencyKey: `usage:${idempotencyKey}`,
    });
  } catch (error) {
    await AiRunModel.deleteOne({ _id: run._id, status: AI_RUN_STATUS.PENDING });
    throw error;
  }

  try {
    const result = await transcribeAudio({
      audio,
      filename,
      contentType,
      language,
    });
    const structuredResult = { text: result.text, language: result.language };
    run.status = AI_RUN_STATUS.COMPLETED;
    run.provider = "openai";
    run.model = result.model;
    run.structuredResult = structuredResult;
    run.outputSummary = result.text.slice(0, 4_000);
    run.usage = {
      ...result.usage,
      reservedCredits: reservation.reservedCredits,
    };
    run.completedAt = new Date();
    await run.save();
    const settled = await settleAiCredits({
      reservationId: String(reservation._id),
      usage: result.usage,
      model: result.model,
      runId: String(run._id),
    });
    run.usage.settledCredits = Number(settled?.settledCredits || 0);
    await run.save();
    return {
      ...structuredResult,
      runId: String(run._id),
      provider: "openai" as const,
      model: result.model,
      credits: Number(settled?.settledCredits || 0),
    };
  } catch (error) {
    await releaseAiCredits(String(reservation._id));
    run.status = AI_RUN_STATUS.FALLBACK;
    run.provider = "deterministic";
    run.errorCode = "AI_PROVIDER_UNAVAILABLE";
    run.errorMessage =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "Transcription failed.";
    run.structuredResult = fallback;
    run.outputSummary = "Transcription was unavailable; no text was invented.";
    run.completedAt = new Date();
    await run.save();
    return {
      ...fallback,
      runId: String(run._id),
      provider: "deterministic" as const,
      model: "unavailable",
      credits: 0,
    };
  }
};

export const aiOrchestratorService = {
  executeStructured: executeStructuredAi,
  executeTranscription: executeAudioTranscriptionAi,
  createIdempotencyKey: createAiIdempotencyKey,
};
