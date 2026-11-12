import type { Request } from "express";

import type {
  AllowedWorkspaceLocationIds,
  ResolvedWorkspaceAccess,
} from "@/modules/tenant-access/index.js";

import type { AiAudience, AiFeature } from "./ai.constants.js";
import type { AiLocale } from "./ai-locale.js";

export type AiRequestContext = {
  tenantId: string;
  userId: string | null;
  audience: AiAudience;
  access?: ResolvedWorkspaceAccess | null;
  allowedLocationIds?: AllowedWorkspaceLocationIds;
  locationId?: string | null;
  locale?: string;
  ipAddress?: string;
  userAgent?: string;
};

export type AiRequest = Request & {
  aiContext?: AiRequestContext;
};

export type AiProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AiProviderResult<T> = {
  value: T;
  model: string;
  responseId: string;
  usage: AiProviderUsage;
  refusal: string | null;
};

export type AiCitation = {
  sourceId: string;
  resourceId?: string;
  title: string;
  audience?: string;
  type?: string;
  category?: string;
  sourceUrl?: string;
  sourceHref?: string;
  version?: number;
  contentHash?: string;
  locale?: AiLocale;
  excerpt?: string;
  updatedAt?: string | Date | null;
  retrievedAt?: string | Date | null;
};

export type AiRunInput = {
  context: AiRequestContext;
  feature: AiFeature;
  promptVersion: string;
  idempotencyKey: string;
  model?: string;
  sourceIds?: string[];
};

export type AiStructuredExecution<T> = {
  value: T;
  runId: string | null;
  provider: "openai" | "deterministic";
  model: string;
  usage: AiProviderUsage;
  credits: number;
  /**
   * Present only when a provider attempt failed and a deterministic fallback
   * was returned. Verified server responses never set this field.
   */
  fallbackReason?: AiProviderFailureCode;
};

export type AiProviderFailureCode =
  | "AI_PROVIDER_SCHEMA_INVALID"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_AUTHENTICATION"
  | "AI_PROVIDER_UPSTREAM";
