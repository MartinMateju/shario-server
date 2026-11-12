import { z } from "zod";

import type { AiProviderResult, AiProviderUsage } from "../ai.types.js";

const transientStatuses = new Set([408, 409, 429, 500, 502, 503, 504]);

type OpenAiRequestError = Error & {
  status?: number;
  providerType?: string;
  providerCode?: string;
  providerParam?: string;
};

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const safeProviderMetadata = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 160);
  return /^[a-zA-Z0-9_.:[\]-]+$/.test(normalized) ? normalized : undefined;
};

const providerErrorMetadataFrom = (
  rawBody: string,
): Pick<OpenAiRequestError, "providerType" | "providerCode" | "providerParam"> => {
  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown };
    if (!isJsonObject(parsed.error)) return {};
    return {
      providerType: safeProviderMetadata(parsed.error.type),
      providerCode: safeProviderMetadata(parsed.error.code),
      providerParam: safeProviderMetadata(parsed.error.param),
    };
  } catch {
    return {};
  }
};

const OPENAI_UNSUPPORTED_SCHEMA_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
] as const;

const assertStrictObjectSchemas = (
  value: unknown,
  path = "$",
): void => {
  if (!isJsonObject(value)) return;

  for (const keyword of OPENAI_UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (Object.prototype.hasOwnProperty.call(value, keyword)) {
      throw new Error(
        `OpenAI strict JSON schema is invalid at ${path}: unsupported keyword ${keyword}.`,
      );
    }
  }

  const properties = value.properties;
  if (isJsonObject(properties)) {
    if (value.additionalProperties !== false) {
      throw new Error(
        `OpenAI strict JSON schema is invalid at ${path}: additionalProperties must be false.`,
      );
    }

    const required = Array.isArray(value.required)
      ? value.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    const missing = Object.keys(properties).filter((key) => !required.includes(key));
    if (missing.length) {
      throw new Error(
        `OpenAI strict JSON schema is invalid at ${path}: every property must be required; missing ${missing.join(", ")}.`,
      );
    }

    for (const [key, property] of Object.entries(properties)) {
      assertStrictObjectSchemas(property, `${path}.${key}`);
    }
  }

  if (isJsonObject(value.items)) {
    assertStrictObjectSchemas(value.items, `${path}[]`);
  }

  const branches = value.anyOf;
  if (Array.isArray(branches)) {
    branches.forEach((branch, index) => {
      assertStrictObjectSchemas(branch, `${path}.anyOf[${index}]`);
    });
  }

  for (const keyword of ["$defs", "definitions"] as const) {
    const definitions = value[keyword];
    if (!isJsonObject(definitions)) continue;
    for (const [key, definition] of Object.entries(definitions)) {
      assertStrictObjectSchemas(definition, `${path}.${keyword}.${key}`);
    }
  }
};

const strictJsonSchemaFrom = (schema: z.ZodType): JsonObject => {
  const jsonSchema = z.toJSONSchema(schema) as JsonObject;
  if (jsonSchema.type !== "object" || Array.isArray(jsonSchema.anyOf)) {
    throw new Error("OpenAI strict JSON schema must have an object at its root.");
  }
  assertStrictObjectSchemas(jsonSchema);
  return jsonSchema;
};

const baseUrl = (): string =>
  String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1")
    .trim()
    .replace(/\/$/, "");

const apiKey = (): string => String(process.env.OPENAI_API_KEY || "").trim();

const timeoutMs = (): number => {
  const parsed = Number(process.env.OPENAI_TIMEOUT_MS || 30_000);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 3_000), 120_000) : 30_000;
};

const maxRetries = (): number => {
  const parsed = Number(process.env.OPENAI_MAX_RETRIES || 2);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 0), 4) : 2;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const getRetryDelay = (response: Response | null, attempt: number): number => {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 10_000);
  }
  return Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 150), 5_000);
};

const openAiFetch = async (
  path: string,
  init: RequestInit,
): Promise<Response> => {
  const key = apiKey();
  if (!key) throw new Error("OPENAI_API_KEY is not configured.");

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries(); attempt += 1) {
    let response: Response | null = null;
    try {
      response = await fetch(`${baseUrl()}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${key}`,
          ...(process.env.OPENAI_PROJECT
            ? { "openai-project": process.env.OPENAI_PROJECT }
            : {}),
          ...(process.env.OPENAI_ORGANIZATION
            ? { "openai-organization": process.env.OPENAI_ORGANIZATION }
            : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs()),
      });

      if (response.ok) return response;

      // Consume the body but never propagate it: provider errors can include
      // echoed input or other sensitive diagnostic content.
      const rawErrorBody = await response.text();
      const providerMetadata = providerErrorMetadataFrom(rawErrorBody);
      const requestId = response.headers.get("x-request-id");
      const diagnostics = [
        providerMetadata.providerType
          ? `type=${providerMetadata.providerType}`
          : "",
        providerMetadata.providerCode
          ? `code=${providerMetadata.providerCode}`
          : "",
        providerMetadata.providerParam
          ? `param=${providerMetadata.providerParam}`
          : "",
        requestId ? `request=${requestId}` : "",
      ].filter(Boolean);
      const error = new Error(
        `OpenAI request failed with status ${response.status}${
          diagnostics.length ? ` (${diagnostics.join(", ")})` : ""
        }.`,
      ) as OpenAiRequestError;
      Object.assign(error, {
        status: response.status,
        ...providerMetadata,
      });

      if (!transientStatuses.has(response.status) || attempt >= maxRetries()) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number })?.status;
      const retryable = status ? transientStatuses.has(status) : true;
      if (!retryable || attempt >= maxRetries()) throw error;
    }

    await wait(getRetryDelay(response, attempt));
  }

  throw lastError instanceof Error ? lastError : new Error("OpenAI request failed.");
};

const nonNegativeFiniteNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
};

const usageFrom = (value: any): AiProviderUsage => {
  const inputTokens = nonNegativeFiniteNumber(value?.input_tokens);
  const outputTokens = nonNegativeFiniteNumber(value?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: nonNegativeFiniteNumber(
      value?.total_tokens ?? inputTokens + outputTokens,
    ),
  };
};

const extractResponseText = (response: any): { text: string; refusal: string | null } => {
  if (response?.status === "incomplete") {
    const reason = String(response?.incomplete_details?.reason || "unknown");
    throw new Error(`OpenAI response was incomplete: ${reason}`);
  }

  let refusal: string | null = null;
  const textParts: string[] = [];

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "refusal") {
        refusal = String(content.refusal || "The request was refused.");
      }
      if (content?.type === "output_text" && typeof content.text === "string") {
        textParts.push(content.text);
      }
    }
  }

  if (refusal) return { text: "", refusal };
  const text = textParts.join("\n").trim();
  if (!text) throw new Error("OpenAI response did not contain output text.");
  return { text, refusal: null };
};

export const isOpenAiConfigured = (): boolean => Boolean(apiKey());

export const createStructuredResponse = async <T>({
  instructions,
  input,
  schema,
  schemaName,
  model = process.env.OPENAI_MODEL || "gpt-5.6-terra",
  maxOutputTokens = 2_000,
}: {
  instructions: string;
  input: string;
  schema: z.ZodType<T>;
  schemaName: string;
  model?: string;
  maxOutputTokens?: number;
}): Promise<AiProviderResult<T>> => {
  const response = await openAiFetch("/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
          schema: strictJsonSchemaFrom(schema),
          strict: true,
        },
      },
    }),
  });

  const body = await response.json() as any;
  const extracted = extractResponseText(body);
  if (extracted.refusal) {
    return {
      value: null as T,
      model: String(body.model || model),
      responseId: String(body.id || ""),
      usage: usageFrom(body.usage),
      refusal: extracted.refusal,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.text);
  } catch {
    throw new Error("OpenAI structured response was not valid JSON.");
  }

  let value: T;
  try {
    value = schema.parse(parsed);
  } catch {
    // Do not attach provider output to the error/log path.
    throw new Error("OpenAI structured response did not match the required schema.");
  }

  return {
    value,
    model: String(body.model || model),
    responseId: String(body.id || ""),
    usage: usageFrom(body.usage),
    refusal: null,
  };
};

export const moderateText = async (
  input: string,
): Promise<{ flagged: boolean; categories: string[] }> => {
  if (!isOpenAiConfigured()) return { flagged: false, categories: [] };
  const response = await openAiFetch("/moderations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest",
      input,
    }),
  });
  const body = await response.json() as any;
  const result = body?.results?.[0] || {};
  const categories = Object.entries(result.categories || {})
    .filter(([, flagged]) => flagged === true)
    .map(([category]) => category);
  return { flagged: Boolean(result.flagged), categories };
};

export const createEmbedding = async (
  input: string,
): Promise<{ vector: number[]; model: string; usage: AiProviderUsage }> => {
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const response = await openAiFetch("/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, encoding_format: "float" }),
  });
  const body = await response.json() as any;
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.every(Number.isFinite)) {
    throw new Error("OpenAI embedding response was invalid.");
  }
  const promptTokens = nonNegativeFiniteNumber(body?.usage?.prompt_tokens);
  return {
    vector,
    model: String(body.model || model),
    usage: { inputTokens: promptTokens, outputTokens: 0, totalTokens: promptTokens },
  };
};

export const transcribeAudio = async ({
  audio,
  filename,
  contentType,
  language,
}: {
  audio: Buffer;
  filename: string;
  contentType: string;
  language?: string;
}): Promise<{ text: string; model: string; language: string; usage: AiProviderUsage }> => {
  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  const form = new FormData();
  form.append("model", model);
  if (language) form.append("language", language);
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: contentType }),
    filename,
  );
  const response = await openAiFetch("/audio/transcriptions", {
    method: "POST",
    body: form,
  });
  const body = await response.json() as any;
  return {
    text: String(body.text || "").trim(),
    model,
    language: String(body.language || language || "").trim(),
    usage: usageFrom(body.usage),
  };
};

export const openAiProvider = {
  createStructuredResponse,
  moderateText,
  createEmbedding,
  transcribeAudio,
  isConfigured: isOpenAiConfigured,
};
